// Team & delegation travel operations (#485), part 1: the trip record, its links to canonical events/fixtures, status, notes and the people who may be invited.
// A trip never copies an event, fixture, roster or identity: it points at them, and every change is appended to the trip history.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { many, one, pool, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin } from '../helpers.js';
import { hasOrgGrant } from '../org-access.js';
import { YOUTH_SQL } from '../youth.js';
import { eventForOrganizer } from './events.js';
import { canManageTeam } from './teams.js';
import { LIVE_PARTICIPANT, TERMINAL, assertOpen, assertPoint, placeFields, assertZoneMatches, audienceOf, canApproveTrip, isTripManager, isZone, localText, maskParty, readiness, record, stale, tripCtx, tripDays, youthIdsAmong } from '../trips.js';

const TAG = 'Team travel';
const dt = z.string().datetime({ offset: true });
const zone = z.string().min(1).max(64).refine(isZone, 'Not a valid IANA time zone, e.g. Europe/London');
const key = z.string().min(8).max(80);
const NEXT = { planning: ['approval_pending', 'confirmed', 'cancelled'], approval_pending: ['planning', 'confirmed', 'cancelled'], confirmed: ['in_progress', 'cancelled'], in_progress: ['completed', 'cancelled'], completed: [], cancelled: [] };

/** May this person tie the trip to the event / fixture? The organiser, or a manager whose owning team is in the event (accepted entry or a fixture side). */
async function mayLinkEvent(user, trip, eventId, fixtureId, c) {
  const ev = (await c.query('SELECT * FROM events WHERE id=$1', [eventId])).rows[0];
  if (!ev) throw notFound('Event');
  let ok = false;
  try { await eventForOrganizer(user, eventId, c); ok = true; } catch { ok = false; }
  if (!ok && trip.team_id) {
    ok = (await c.query("SELECT 1 FROM event_entries WHERE event_id=$1 AND team_id=$2 AND status='accepted'", [eventId, trip.team_id])).rowCount > 0
      || (await c.query('SELECT 1 FROM fixtures WHERE event_id=$1 AND (home_team_id=$2 OR away_team_id=$2)', [eventId, trip.team_id])).rowCount > 0;
  }
  if (!ok && trip.organisation_id) ok = ev.organisation_id === trip.organisation_id;
  if (!ok) throw notFound('Event');
  if (fixtureId) {
    const f = (await c.query('SELECT * FROM fixtures WHERE id=$1 AND event_id=$2', [fixtureId, eventId])).rows[0];
    if (!f) throw notFound('Fixture');
  }
  return ev;
}

async function linkEvents(c, user, trip, events, fixtures) {
  for (const eventId of events) await attach(c, user, trip, eventId, null);
  for (const fid of fixtures) {
    const f = (await c.query('SELECT event_id FROM fixtures WHERE id=$1', [fid])).rows[0];
    if (!f) throw notFound('Fixture');
    await attach(c, user, trip, f.event_id, fid);
  }
}
async function attach(c, user, trip, eventId, fixtureId) {
  await mayLinkEvent(user, trip, eventId, fixtureId, c);
  const row = (await c.query('INSERT INTO trip_events(trip_id, event_id, fixture_id, linked_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id', [trip.id, eventId, fixtureId, user.id])).rows[0];
  if (row) await record(c, trip, user.id, { entity: 'event_link', entityId: row.id, action: 'linked', snapshot: { event_id: eventId, fixture_id: fixtureId } });
}

const TRIP_COLS = 't.*, tm.name AS team_name, o.name AS organisation_name, s.name AS sport_name, mu.display_name AS manager_name';
const TRIP_JOIN = 'FROM trips t LEFT JOIN teams tm ON tm.id=t.team_id LEFT JOIN organisations o ON o.id=t.organisation_id LEFT JOIN sports s ON s.id=t.sport_id LEFT JOIN users mu ON mu.id=t.manager_id';
const shape = (t) => ({ ...t, depart_local: localText(t.depart_at, t.timezone), return_local: localText(t.return_at, t.timezone), days: tripDays(t) });

cap({
  name: 'create_trip', method: 'POST', path: '/trips', tag: TAG, status: 201,
  summary: 'Create a trip / delegation for a team or organisation you run, tied to the events and fixtures it travels for. Dates are timezone-aware; the manager joins the travel party. The same idempotency_key returns the trip already created.',
  input: z.object({
    name: z.string().trim().min(2).max(120), purpose: z.string().trim().max(500).optional(),
    team_id: id.optional(), organisation_id: id.optional(), sport: z.string().optional().describe('sport slug or id; defaults to the team\'s sport'), competition: z.string().trim().max(120).optional(),
    origin: z.string().trim().min(1).max(160), ...placeFields('origin_'), destination: z.string().trim().min(1).max(160), ...placeFields('destination_'), timezone: zone.describe('IANA zone of the destination'),
    depart_at: dt, return_at: dt, manager_id: id.optional().describe('defaults to you; must be on the owning team or organisation'),
    allow_guests: z.boolean().default(false), documents_required: z.boolean().default(false), passport_min_months: z.number().int().min(0).max(24).default(6),
    event_ids: z.array(id).max(10).default([]), fixture_ids: z.array(id).max(30).default([]), idempotency_key: key.optional(),
  }),
  async handler({ user }, i) {
    if (!i.team_id && !i.organisation_id) throw badRequest('Choose the team or organisation this trip belongs to');
    assertPoint(i, 'origin_'); assertPoint(i, 'destination_');
    if (Date.parse(i.return_at) <= Date.parse(i.depart_at)) throw badRequest('The return must be after the departure');
    return tx(async (c) => {
      if (i.idempotency_key) {
        const dup = (await c.query('SELECT id FROM trips WHERE created_by=$1 AND idempotency_key=$2', [user.id, i.idempotency_key])).rows[0];
        if (dup) return shape((await c.query(`SELECT ${TRIP_COLS} ${TRIP_JOIN} WHERE t.id=$1`, [dup.id])).rows[0]);
      }
      let sportId = null, basis = 'organisation';
      if (i.team_id) {
        const team = (await c.query('SELECT * FROM teams WHERE id=$1', [i.team_id])).rows[0];
        if (!team || !(await canManageTeam(user, team))) throw notFound('Team');
        sportId = team.sport_id; basis = 'team_roster';
        if (i.organisation_id && team.organisation_id !== i.organisation_id) throw badRequest('That team does not belong to this organisation');
      }
      if (i.organisation_id && !(await hasOrgGrant(user, i.organisation_id, ['owner', 'admin'], c)) && !isAdmin(user)) throw notFound('Organisation');
      if (i.sport) {
        const sp = (await c.query('SELECT id FROM sports WHERE slug=$1 OR id::text=$1', [i.sport])).rows[0];
        if (!sp) throw notFound('Sport');
        sportId = sp.id;
      }
      const managerId = i.manager_id ?? user.id;
      if (managerId !== user.id) {
        const member = (i.team_id && (await c.query("SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2 AND status='active'", [i.team_id, managerId])).rowCount)
          || (i.organisation_id && (await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [i.organisation_id, managerId])).rowCount);
        if (!member) throw badRequest('The trip manager must belong to the team or organisation');
      }
      if ((await youthIdsAmong(c, [managerId])).length) throw badRequest('A young person cannot manage a trip');
      const t = (await c.query(
        `INSERT INTO trips(name, purpose, team_id, organisation_id, sport_id, competition, origin, destination, origin_country, origin_lat, origin_lng, destination_country, destination_lat, destination_lng, timezone, depart_at, return_at, manager_id, allow_guests, documents_required, passport_min_months, idempotency_key, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$18,$19,$20,$21,$22,$23,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
        [i.name, i.purpose ?? null, i.team_id ?? null, i.organisation_id ?? null, sportId, i.competition ?? null, i.origin, i.destination, i.timezone, i.depart_at, i.return_at, managerId, i.allow_guests, i.documents_required, i.passport_min_months, i.idempotency_key ?? null, user.id, i.origin_country ?? null, i.origin_lat ?? null, i.origin_lng ?? null, i.destination_country ?? null, i.destination_lat ?? null, i.destination_lng ?? null])).rows[0];
      await c.query("INSERT INTO trip_participants(trip_id, user_id, role, status, basis, invited_by, responded_at) VALUES ($1,$2,'manager','confirmed',$3,$4,now())", [t.id, managerId, basis, user.id]);
      await record(c, t, user.id, { entity: 'trip', entityId: t.id, action: 'created', version: 1, snapshot: { name: t.name, status: t.status } });
      await linkEvents(c, user, t, i.event_ids, i.fixture_ids);
      return shape((await c.query(`SELECT ${TRIP_COLS} ${TRIP_JOIN} WHERE t.id=$1`, [t.id])).rows[0]);
    });
  },
});

cap({
  name: 'list_trips', method: 'GET', path: '/trips', tag: TAG,
  summary: 'Trips you run, travel on, or are a verified guardian of a young traveller on. Filter by status, team, organisation or linked event. Young travellers\' trips are never public.',
  input: z.object({ status: z.enum(['planning', 'approval_pending', 'confirmed', 'in_progress', 'completed', 'cancelled', 'open']).optional().describe('open = not completed or cancelled'), team_id: id.optional(), organisation_id: id.optional(), event_id: id.optional(), country: z.string().regex(/^[A-Z]{2}$/).optional().describe('destination country, two-letter code'), ...page }),
  async handler({ user }, i) {
    const params = [user.id, i.limit, i.offset]; const where = [];
    if (i.status === 'open') where.push("t.status NOT IN ('completed','cancelled')"); else if (i.status) { params.push(i.status); where.push(`t.status=$${params.length}`); }
    if (i.country) { params.push(i.country); where.push(`t.destination_country=$${params.length}`); }
    if (i.team_id) { params.push(i.team_id); where.push(`t.team_id=$${params.length}`); }
    if (i.organisation_id) { params.push(i.organisation_id); where.push(`t.organisation_id=$${params.length}`); }
    if (i.event_id) { params.push(i.event_id); where.push(`EXISTS (SELECT 1 FROM trip_events e WHERE e.trip_id=t.id AND e.event_id=$${params.length} AND e.unlinked_at IS NULL)`); }
    const admin = isAdmin(user);
    const rows = await many(
      `SELECT ${TRIP_COLS},
         (SELECT count(*)::int FROM trip_participants p WHERE p.trip_id=t.id AND p.status IN ('invited','confirmed')) AS party_size,
         (SELECT count(*)::int FROM trip_participants p WHERE p.trip_id=t.id AND p.status='confirmed') AS confirmed
       ${TRIP_JOIN}
       WHERE (${admin ? 'true' : 'false'}
          OR t.manager_id=$1
          OR EXISTS (SELECT 1 FROM trip_participants p WHERE p.trip_id=t.id AND p.user_id=$1 AND p.status IN ('invited','confirmed'))
          OR EXISTS (SELECT 1 FROM trip_participants p JOIN guardian_links l ON l.child_id=p.user_id AND l.guardian_id=$1 AND l.status='active' AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now()) WHERE p.trip_id=t.id AND p.status IN ('invited','confirmed'))
          OR EXISTS (SELECT 1 FROM teams x WHERE x.id=t.team_id AND (x.owner_id=$1 OR EXISTS (SELECT 1 FROM team_members m WHERE m.team_id=x.id AND m.user_id=$1 AND m.status='active' AND m.role IN ('captain','manager'))))
          OR EXISTS (SELECT 1 FROM organisation_members m WHERE m.organisation_id=t.organisation_id AND m.user_id=$1 AND m.status='active' AND m.role IN ('owner','admin')))
         ${where.length ? 'AND ' + where.join(' AND ') : ''}
       ORDER BY (t.status IN ('completed','cancelled')), t.depart_at LIMIT $2 OFFSET $3`, params);
    return rows.map(shape);
  },
});

cap({
  name: 'get_trip', method: 'GET', path: '/trips/:id', tag: TAG,
  summary: 'One trip: the record, linked events and fixtures, the travel party (young travellers are shown by name only to trip staff, themselves and their guardians), notes you may see, and what you are allowed to do.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ctx = await tripCtx(user, i.id);
    const { trip } = ctx;
    const full = (await one(`SELECT ${TRIP_COLS} ${TRIP_JOIN} WHERE t.id=$1`, [trip.id]));
    const links = await many(
      `SELECT l.id, l.event_id, e.name AS event_name, e.starts_on, e.ends_on, l.fixture_id, f.scheduled_at, f.round, ht.name AS home_name, at.name AS away_name
         FROM trip_events l JOIN events e ON e.id=l.event_id LEFT JOIN fixtures f ON f.id=l.fixture_id LEFT JOIN teams ht ON ht.id=f.home_team_id LEFT JOIN teams at ON at.id=f.away_team_id
        WHERE l.trip_id=$1 AND l.unlinked_at IS NULL ORDER BY coalesce(f.scheduled_at, e.starts_on::timestamptz)`, [trip.id]);
    const raw = await many(`SELECT p.id, p.user_id, p.role, p.status, p.basis, p.guardian_of, p.responded_at, u.display_name, u.handle, u.avatar_emoji FROM trip_participants p JOIN users u ON u.id=p.user_id WHERE p.trip_id=$1 AND p.status = ANY($2) ORDER BY p.created_at`, [trip.id, LIVE_PARTICIPANT]);
    const youth = new Set(await youthIdsAmong(pool, raw.map((r) => r.user_id)));
    const notes = await many(`SELECT id, kind, visibility, body, done, done_at, created_at FROM trip_notes WHERE trip_id=$1 AND archived_at IS NULL AND ($2 OR visibility='party') ORDER BY created_at`, [trip.id, ctx.ops]);
    return {
      trip: shape(full), events: links, party: maskParty(raw, ctx, youth), notes,
      you: { manager: ctx.manager, ops: ctx.ops, participant_id: ctx.mine?.id ?? null, role: ctx.mine?.role ?? null, status: ctx.mine?.status ?? null, guardian_of: ctx.wards.map((w) => w.id), can_approve: ctx.manager ? await canApproveTrip(user, trip) : false },
    };
  },
});

cap({
  name: 'update_trip', method: 'PATCH', path: '/trips/:id', tag: TAG,
  summary: 'Trip manager: change the name, purpose, places, dates, manager or policy flags. Needs the current row_version; the previous values are kept in the trip history and travellers are told when the window moves.',
  input: z.object({ id, row_version: z.number().int(), name: z.string().trim().min(2).max(120).optional(), purpose: z.string().trim().max(500).nullable().optional(), competition: z.string().trim().max(120).nullable().optional(),
    origin: z.string().trim().min(1).max(160).optional(), ...placeFields('origin_'), destination: z.string().trim().min(1).max(160).optional(), ...placeFields('destination_'), timezone: zone.optional(), depart_at: dt.optional(), return_at: dt.optional(),
    allow_guests: z.boolean().optional(), documents_required: z.boolean().optional(), passport_min_months: z.number().int().min(0).max(24).optional(), manager_id: id.optional(), note: z.string().trim().max(300).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      if (!ctx.manager) throw forbidden('Only the trip manager can change the trip');
      assertOpen(ctx.trip); stale(ctx.trip, i.row_version);
      const { id: _i, row_version: _v, note, ...ch } = i;
      const before = ctx.trip;
      if (ch.manager_id && ch.manager_id !== before.manager_id) {
        const ok = (await c.query("SELECT 1 FROM trip_participants WHERE trip_id=$1 AND user_id=$2 AND status='confirmed' AND role IN ('manager','chaperone','coach','staff')", [before.id, ch.manager_id])).rowCount;
        if (!ok) throw badRequest('Choose a confirmed manager, chaperone, coach or staff member of this trip as the new manager');
        if ((await youthIdsAmong(c, [ch.manager_id])).length) throw badRequest('A young person cannot manage a trip');
      }
      const next = { ...before, ...Object.fromEntries(Object.entries(ch).filter(([, v]) => v !== undefined)) };
      if (Date.parse(next.return_at) <= Date.parse(next.depart_at)) throw badRequest('The return must be after the departure');
      assertPoint(next, 'origin_'); assertPoint(next, 'destination_');
      const cols = ['name', 'purpose', 'competition', 'origin', 'origin_country', 'origin_lat', 'origin_lng', 'destination', 'destination_country', 'destination_lat', 'destination_lng', 'timezone', 'depart_at', 'return_at', 'allow_guests', 'documents_required', 'passport_min_months', 'manager_id'].filter((k) => ch[k] !== undefined);
      if (!cols.length) throw badRequest('Nothing to change');
      const row = (await c.query(`UPDATE trips SET ${cols.map((k, n) => `${k}=$${n + 2}`).join(', ')}, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *`, [before.id, ...cols.map((k) => ch[k])])).rows[0];
      const moved = row.depart_at.getTime() !== before.depart_at.getTime() || row.return_at.getTime() !== before.return_at.getTime() || row.timezone !== before.timezone;
      const party = (await c.query('SELECT id FROM trip_participants WHERE trip_id=$1 AND status = ANY($2)', [before.id, LIVE_PARTICIPANT])).rows.map((r) => r.id);
      await record(c, row, user.id, { entity: 'trip', entityId: row.id, action: 'updated', version: row.row_version, snapshot: { before: Object.fromEntries(cols.map((k) => [k, before[k]])), after: Object.fromEntries(cols.map((k) => [k, row[k]])) }, note,
        affected: moved ? await audienceOf(c, row, party) : [], title: moved ? 'Trip dates changed' : undefined, body: `${row.name}: now ${localText(row.depart_at, row.timezone)} to ${localText(row.return_at, row.timezone)}` });
      return shape((await c.query(`SELECT ${TRIP_COLS} ${TRIP_JOIN} WHERE t.id=$1`, [row.id])).rows[0]);
    });
  },
});

cap({
  name: 'set_trip_status', method: 'POST', path: '/trips/:id/status', tag: TAG,
  summary: 'Move a trip through planning → approval_pending → confirmed → in_progress → completed (or cancelled with a reason). Only the owning team owner / organisation admin can approve; a trip with young travellers cannot be confirmed without a confirmed adult manager or chaperone. Cancelling keeps every record and tells the party.',
  input: z.object({ id, to: z.enum(['planning', 'approval_pending', 'confirmed', 'in_progress', 'completed', 'cancelled']), note: z.string().trim().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      const { trip } = ctx;
      if (!ctx.manager) throw forbidden('Only the trip manager can change the status');
      if (!NEXT[trip.status].includes(i.to)) throw conflict(`A ${trip.status} trip cannot move to ${i.to}`);
      if (i.to === 'cancelled' && !i.note) throw badRequest('Say why the trip is cancelled');
      const approves = trip.status === 'approval_pending' && i.to === 'confirmed' || trip.status === 'planning' && i.to === 'confirmed';
      if (approves && !(await canApproveTrip(user, trip, c))) throw forbidden(trip.status === 'planning' ? 'Send the trip for approval; only the team owner or organisation admin can confirm it' : 'Only the team owner or organisation admin can approve this trip');
      if (i.to === 'confirmed') {
        const r = await readiness(c, trip);
        if (r.anyYouth && !r.adultsLeading) throw conflict('Young travellers are on this trip: add and confirm an adult manager or chaperone first', { code: 'chaperone_required' });
      }
      const sets = ['status=$2', 'status_reason=$3', 'row_version=row_version+1', 'updated_at=now()'];
      if (i.to === 'approval_pending') sets.push('approval_requested_by=$4', 'approval_requested_at=now()');
      if (i.to === 'confirmed') sets.push('approved_by=$4', 'approved_at=now()');
      const row = (await c.query(`UPDATE trips SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, [trip.id, i.to, i.note ?? null, ...(['approval_pending', 'confirmed'].includes(i.to) ? [user.id] : [])])).rows[0];
      const party = (await c.query('SELECT id FROM trip_participants WHERE trip_id=$1 AND status = ANY($2)', [trip.id, LIVE_PARTICIPANT])).rows.map((r) => r.id);
      const tell = ['confirmed', 'in_progress', 'cancelled', 'completed'].includes(i.to);
      await record(c, row, user.id, { entity: 'trip', entityId: row.id, action: `status_${i.to}`, version: row.row_version, snapshot: { from: trip.status, to: i.to }, note: i.note,
        affected: tell ? await audienceOf(c, row, party) : [await approverIds(c, row)].flat(), title: tell ? `Trip ${i.to.replace('_', ' ')}` : 'A trip needs approval', body: `${row.name}${i.note ? `: ${i.note}` : ''}` });
      return shape((await c.query(`SELECT ${TRIP_COLS} ${TRIP_JOIN} WHERE t.id=$1`, [row.id])).rows[0]);
    });
  },
});
const approverIds = async (c, trip) => (await c.query(
  `SELECT x.owner_id AS u FROM teams x WHERE x.id=$1 UNION SELECT m.user_id FROM organisation_members m WHERE m.organisation_id=$2 AND m.status='active' AND m.role IN ('owner','admin')`, [trip.team_id, trip.organisation_id])).rows.map((r) => r.u);

cap({
  name: 'link_trip_event', method: 'POST', path: '/trips/:id/events', tag: TAG, status: 201,
  summary: 'Tie the trip to a canonical event, or to one of its fixtures (organiser, or a manager whose team is entered / playing). The fixture is only referenced: a travel change never edits it.',
  input: z.object({ id, event_id: id, fixture_id: id.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      if (!ctx.manager) throw forbidden('Only the trip manager can link events');
      assertOpen(ctx.trip);
      await attach(c, user, ctx.trip, i.event_id, i.fixture_id ?? null);
      return many('SELECT id, event_id, fixture_id, linked_at FROM trip_events WHERE trip_id=$1 AND unlinked_at IS NULL ORDER BY linked_at', [ctx.trip.id]).then((r) => r);
    });
  },
});

cap({
  name: 'unlink_trip_event', method: 'POST', path: '/trips/:id/events/:link_id/unlink', tag: TAG,
  summary: 'Remove an event / fixture link from the trip. The link is kept in the trip history; the event and fixture are untouched.',
  input: z.object({ id, link_id: id }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      if (!ctx.manager) throw forbidden('Only the trip manager can unlink events');
      assertOpen(ctx.trip);
      const l = (await c.query('UPDATE trip_events SET unlinked_at=now() WHERE id=$1 AND trip_id=$2 AND unlinked_at IS NULL RETURNING *', [i.link_id, ctx.trip.id])).rows[0];
      if (!l) throw notFound('Link');
      await record(c, ctx.trip, user.id, { entity: 'event_link', entityId: l.id, action: 'unlinked', snapshot: { event_id: l.event_id, fixture_id: l.fixture_id } });
      return { ok: true };
    });
  },
});

cap({
  name: 'list_trip_candidates', method: 'GET', path: '/trips/:id/candidates', tag: TAG,
  summary: 'Who can be invited to this trip, from canonical records only: the owning team\'s active members, the organisation\'s members, and officials accepted on the linked fixtures. Anyone already on the party is left out. Young people are flagged so the manager knows trip-specific guardian consent will be needed.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ctx = await tripCtx(user, i.id);
    if (!ctx.manager) throw forbidden('Only the trip manager can see who can be invited');
    const t = ctx.trip;
    const ROLE = { captain: 'athlete', player: 'athlete', coach: 'coach', manager: 'staff', physio: 'medical' };
    const team = t.team_id ? await many(`SELECT u.id AS user_id, u.display_name, u.avatar_emoji, m.role AS source_role, (${YOUTH_SQL}) AS young FROM team_members m JOIN users u ON u.id=m.user_id WHERE m.team_id=$1 AND m.status='active'`, [t.team_id]) : [];
    const org = t.organisation_id ? await many(`SELECT u.id AS user_id, u.display_name, u.avatar_emoji, m.role AS source_role, (${YOUTH_SQL}) AS young FROM organisation_members m JOIN users u ON u.id=m.user_id WHERE m.organisation_id=$1 AND m.status='active'`, [t.organisation_id]) : [];
    const off = await many(`SELECT DISTINCT u.id AS user_id, u.display_name, u.avatar_emoji, fo.role AS source_role, (${YOUTH_SQL}) AS young FROM fixture_officials fo JOIN trip_events l ON l.fixture_id=fo.fixture_id AND l.trip_id=$1 AND l.unlinked_at IS NULL JOIN users u ON u.id=fo.user_id WHERE fo.status='accepted'`, [t.id]);
    const taken = new Set((await many('SELECT user_id FROM trip_participants WHERE trip_id=$1 AND status = ANY($2)', [t.id, LIVE_PARTICIPANT])).map((r) => r.user_id));
    const out = new Map();
    for (const [rows, basis, role] of [[team, 'team_roster', (r) => ROLE[r.source_role] ?? 'staff'], [org, 'organisation', () => 'staff'], [off, 'official_assignment', () => 'official']])
      for (const r of rows) if (!taken.has(r.user_id) && !out.has(r.user_id)) out.set(r.user_id, { user_id: r.user_id, display_name: r.display_name, avatar_emoji: r.avatar_emoji, basis, suggested_role: role(r), young: r.young });
    return [...out.values()];
  },
});

cap({
  name: 'add_trip_note', method: 'POST', path: '/trips/:id/notes', tag: TAG, status: 201,
  summary: 'Add a note or checklist item. Visibility: managers (trip staff only) or party (everyone on the trip).',
  input: z.object({ id, kind: z.enum(['note', 'checklist']).default('note'), visibility: z.enum(['managers', 'party']).default('managers'), body: z.string().trim().min(1).max(1000) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c);
      if (!ctx.ops) throw forbidden('Only trip staff can add notes');
      assertOpen(ctx.trip);
      return (await c.query('INSERT INTO trip_notes(trip_id, kind, visibility, body, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, kind, visibility, body, done, created_at', [ctx.trip.id, i.kind, i.visibility, i.body, user.id])).rows[0];
    });
  },
});

cap({
  name: 'update_trip_note', method: 'PATCH', path: '/trips/:id/notes/:note_id', tag: TAG,
  summary: 'Tick or untick a checklist item, or archive a note (archived notes are kept, just hidden).',
  input: z.object({ id, note_id: id, done: z.boolean().optional(), archived: z.boolean().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c);
      if (!ctx.ops) throw forbidden('Only trip staff can change notes');
      assertOpen(ctx.trip);
      const n = (await c.query('SELECT * FROM trip_notes WHERE id=$1 AND trip_id=$2', [i.note_id, ctx.trip.id])).rows[0];
      if (!n) throw notFound('Note');
      return (await c.query(`UPDATE trip_notes SET done=coalesce($3::boolean, done), done_by=CASE WHEN $3::boolean IS NULL THEN done_by WHEN $3::boolean THEN $4::uuid ELSE NULL END, done_at=CASE WHEN $3::boolean IS NULL THEN done_at WHEN $3::boolean THEN now() ELSE NULL END,
        archived_at=CASE WHEN $5::boolean IS NULL THEN archived_at WHEN $5 THEN coalesce(archived_at, now()) ELSE NULL END WHERE id=$1 AND trip_id=$2 RETURNING id, kind, visibility, body, done, done_at, archived_at`, [n.id, ctx.trip.id, i.done ?? null, user.id, i.archived ?? null])).rows[0];
    });
  },
});

cap({
  name: 'list_trip_changes', method: 'GET', path: '/trips/:id/changes', tag: TAG,
  summary: 'The trip\'s change history, newest first: what changed, by whom, with version and a snapshot. Trip staff see everything; a traveller or guardian sees only the changes that affected them.',
  input: z.object({ id, ...page }),
  async handler({ user }, i) {
    const ctx = await tripCtx(user, i.id);
    return many(
      `SELECT ch.id, ch.entity, ch.entity_id, ch.action, ch.version, ${ctx.ops ? 'ch.snapshot' : "'{}'::jsonb AS snapshot"}, ch.note, ch.created_at, u.display_name AS actor_name, (cardinality(ch.affected_user_ids)) AS people_told
         FROM trip_changes ch LEFT JOIN users u ON u.id=ch.actor_id
        WHERE ch.trip_id=$1 AND ($2 OR $3 = ANY(ch.affected_user_ids)) ORDER BY ch.created_at DESC, ch.id LIMIT $4 OFFSET $5`, [ctx.trip.id, ctx.ops, user.id, i.limit, i.offset]);
  },
});
