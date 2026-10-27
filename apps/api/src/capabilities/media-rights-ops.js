// Sports Media, Broadcast & Rights (#482) 2/4: production crew, run sheet / call sheet, operational incidents and changes, and the honest streaming record.
// Crew are canonical users on canonical games; the badge is read live from the event department member (the accreditation that exists today), never copied.
// A stream is a REFERENCE to an external stream: nothing here pretends to be a video platform, and "live" is only ever what the organiser or partner reported.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { notify } from '../notify.js';
import { isYouth, requireConsent } from '../youth.js';
import { CREW_ROLES, ZONES, RESTRICTED_ZONES, STREAM_PROVIDERS, logMr, eventOf, isOrganiserOf, myPartners, partnerFor, eventOrganisers, partnerAdmins, IN_FORCE } from '../media-rights.js';

const TAG = 'Media production';
const text = (n) => z.string().trim().max(n);
const dt = z.string().datetime({ offset: true });
const https = z.string().url().regex(/^https:\/\//, 'Use a secure https link').max(500);

/** The caller's standing on an event's media operations: organiser, a partner with a licence in force (which ones), and/or crew. */
async function standing(user, eventId, c = pool) {
  const ev = await eventOf(eventId, c);
  const organiser = await isOrganiserOf(user, ev, c);
  const licences = (await c.query(
    `SELECT l.id, l.partner_id, l.approved_rights, p.fixture_id, p.scope_kind, m.organisation_id FROM mr_licences l JOIN mr_packages p ON p.id=l.package_id JOIN media_partners m ON m.id=l.partner_id
       JOIN organisation_members om ON om.organisation_id=m.organisation_id AND om.user_id=$2 AND om.status='active'
      WHERE p.event_id=$1 AND ${IN_FORCE()}`, [eventId, user.id])).rows;
  const acting = [];
  for (const l of licences) { try { await partnerFor(user, l.partner_id, { write: true, c }); acting.push(l); } catch { /* member, but cannot act */ } }
  const crew = (await c.query("SELECT 1 FROM mr_crew WHERE event_id=$1 AND user_id=$2 AND status IN ('assigned','acknowledged')", [eventId, user.id])).rowCount > 0;
  return { ev, organiser, licences, acting, crew, any: organiser || licences.length > 0 || crew };
}
const needAny = (s) => { if (!s.any) throw notFound('Event'); };

// ------------------------------------------------------------------ crew
const CREW_VIEW = `c.id, c.event_id, c.fixture_id, c.licence_id, c.user_id, u.display_name, u.handle, c.role, c.zones, c.call_time, c.camera_position, c.booth_ref, c.technical_provider, c.notes, c.status, c.acknowledged_at,
  coalesce((SELECT m.accreditation FROM event_department_members m WHERE m.id=c.department_member_id), 'none') AS accreditation, c.department_member_id,
  (c.restricted_approved_by IS NOT NULL) AS restricted_zones_approved, o.name AS partner_name`;
const CREW_FROM = `mr_crew c JOIN users u ON u.id=c.user_id LEFT JOIN mr_licences l ON l.id=c.licence_id LEFT JOIN media_partners mp ON mp.id=l.partner_id LEFT JOIN organisations o ON o.id=mp.organisation_id`;
const withReady = (r) => ({ ...r, ready: r.status === 'acknowledged' && r.accreditation === 'issued' });

cap({
  name: 'save_crew_assignment', method: 'POST', path: '/events/:id/media/crew', tag: TAG, status: 201,
  summary: 'Assign a person to the production of an event or one game as producer, director, camera operator, commentator, analyst, photographer, audio engineer, technical crew or reporter, with call time, zones, camera position / commentary booth and technical provider. The organiser assigns anyone; a partner assigns its own crew under a licence in force. Restricted areas (locker room, athlete area, officials\' room …) are never granted by a media agreement: only the organiser can approve them. Pass `crew_id` to change one.',
  input: z.object({ id, crew_id: id.optional(), user_id: id, role: z.enum(CREW_ROLES), fixture_id: id.optional(), licence_id: id.optional(), zones: z.array(z.enum(ZONES)).max(10).default(['media_centre', 'mixed_zone']),
    call_time: dt.optional(), camera_position: text(60).optional(), booth_ref: text(60).optional(), technical_provider: text(120).optional(), notes: text(500).optional(), department_member_id: id.optional().describe('the person\'s membership of an event department, where their badge is tracked') }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = await standing(user, i.id, c);
    if (!s.organiser && !s.acting.length) throw forbidden('Only the organiser, or a media partner with rights in force, can assign crew');
    let lic = null;
    if (i.licence_id) {
      lic = s.licences.find((l) => l.id === i.licence_id);
      if (!lic || (!s.organiser && !s.acting.some((l) => l.id === i.licence_id))) {
        lic = s.organiser ? (await c.query(`SELECT l.id, l.partner_id, p.fixture_id, p.scope_kind FROM mr_licences l JOIN mr_packages p ON p.id=l.package_id JOIN media_partners m ON m.id=l.partner_id WHERE l.id=$1 AND p.event_id=$2 AND ${IN_FORCE()}`, [i.licence_id, i.id])).rows[0] : null;
        if (!lic) throw badRequest('That licence is not in force for this event');
      }
    } else if (!s.organiser) throw badRequest('Say which of your licences this crew member works under');
    if (i.fixture_id && !(await c.query('SELECT 1 FROM fixtures WHERE id=$1 AND event_id=$2', [i.fixture_id, i.id])).rowCount) throw badRequest('Choose a game of this event');
    if (lic?.scope_kind === 'fixture' && i.fixture_id !== lic.fixture_id) throw badRequest('This licence only covers one game; assign crew to that game');
    if (!(await c.query('SELECT 1 FROM users WHERE id=$1', [i.user_id])).rowCount) throw notFound('Person');
    if (await isYouth(i.user_id, c)) await requireConsent(i.user_id, 'participation', 'working on a production', c);
    const restricted = i.zones.filter((z) => RESTRICTED_ZONES.includes(z));
    if (restricted.length && !s.organiser) throw forbidden('A media agreement does not open locker rooms or other restricted areas; ask the organiser to approve them');
    if (i.department_member_id && !(await c.query("SELECT 1 FROM event_department_members WHERE id=$1 AND event_id=$2 AND user_id=$3 AND status IN ('invited','active')", [i.department_member_id, i.id, i.user_id])).rowCount) throw badRequest('That is not this person\'s place in an event department');
    // the badge lives with the person's place in an event department: use the one named, else their media / technical department membership if they have one
    const member = i.department_member_id ?? (await c.query(
      `SELECT m.id FROM event_department_members m JOIN event_departments d ON d.id=m.department_id WHERE m.event_id=$1 AND m.user_id=$2 AND m.status IN ('invited','active')
        ORDER BY (d.kind='media') DESC, (d.kind='tech') DESC, m.id LIMIT 1`, [i.id, i.user_id])).rows[0]?.id ?? null;
    const v = [i.fixture_id ?? null, lic?.id ?? null, i.user_id, i.role, [...new Set(i.zones)], restricted.length ? user.id : null, member, i.call_time ?? null, i.camera_position ?? null, i.booth_ref ?? null, i.technical_provider ?? null, i.notes ?? null];
    let row;
    try {
      if (i.crew_id) {
        const cur = (await c.query('SELECT * FROM mr_crew WHERE id=$1 AND event_id=$2 FOR UPDATE', [i.crew_id, i.id])).rows[0];
        if (!cur) throw notFound('Assignment');
        if (!s.organiser && !s.acting.some((l) => l.id === cur.licence_id)) throw forbidden('This is not your crew');
        if (['released', 'declined'].includes(cur.status)) throw conflict('That assignment has ended');
        row = (await c.query("UPDATE mr_crew SET fixture_id=$2, licence_id=$3, user_id=$4, role=$5, zones=$6, restricted_approved_by=$7, department_member_id=$8, call_time=$9, camera_position=$10, booth_ref=$11, technical_provider=$12, notes=$13, status='assigned', acknowledged_at=NULL, updated_at=now() WHERE id=$1 RETURNING *", [cur.id, ...v])).rows[0];
        await logMr(c, i.id, 'crew', row.id, 'updated', { actor: user.id });
      } else {
        row = (await c.query('INSERT INTO mr_crew(event_id, assigned_by, fixture_id, licence_id, user_id, role, zones, restricted_approved_by, department_member_id, call_time, camera_position, booth_ref, technical_provider, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *', [i.id, user.id, ...v])).rows[0];
        await logMr(c, i.id, 'crew', row.id, 'assigned', { actor: user.id, detail: { role: row.role, user_id: row.user_id, zones: row.zones } });
      }
    } catch (e) { if (e.code === '23505') throw conflict('That person already has this role on this game'); throw e; }
    await notify(c, row.user_id, { kind: 'media_crew_assigned', title: 'Production assignment', body: `${s.ev.name}: you are assigned as ${row.role.replace('_', ' ')}${row.call_time ? ` · call ${new Date(row.call_time).toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''}. Please confirm.`, data: { crew_id: row.id, event_id: i.id }, dedupe_key: `mr-crew:${row.id}:${row.updated_at.getTime()}` });
    return withReady((await c.query(`SELECT ${CREW_VIEW} FROM ${CREW_FROM} WHERE c.id=$1`, [row.id])).rows[0]);
  }),
});

cap({
  name: 'respond_crew_assignment', method: 'POST', path: '/media/crew/:id/respond', tag: TAG,
  summary: 'Confirm (acknowledge) or decline your production assignment. The organiser and the partner see the answer.',
  input: z.object({ id, accept: z.boolean(), reason: text(300).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const cur = (await c.query('SELECT * FROM mr_crew WHERE id=$1 AND user_id=$2 FOR UPDATE', [i.id, user.id])).rows[0];
    if (!cur) throw notFound('Assignment');
    if (!['assigned', 'acknowledged'].includes(cur.status)) throw conflict('That assignment has ended');
    if (!i.accept && !i.reason) throw badRequest('Say why you cannot do it', { code: 'reason_required' });
    const row = (await c.query('UPDATE mr_crew SET status=$2, acknowledged_at=CASE WHEN $2=\'acknowledged\' THEN now() ELSE NULL END, updated_at=now() WHERE id=$1 RETURNING *', [cur.id, i.accept ? 'acknowledged' : 'declined'])).rows[0];
    await logMr(c, cur.event_id, 'crew', cur.id, i.accept ? 'acknowledged' : 'declined', { actor: user.id, detail: { reason: i.reason ?? null } });
    const ev = await eventOf(cur.event_id, c);
    const tellIds = [...(await eventOrganisers(c, ev)), ...(cur.licence_id ? await partnerAdmins(c, (await c.query('SELECT partner_id FROM mr_licences WHERE id=$1', [cur.licence_id])).rows[0].partner_id) : [])];
    for (const uid of new Set(tellIds)) await notify(c, uid, { kind: 'media_crew_response', title: i.accept ? 'Crew confirmed' : 'Crew declined', body: `${user.display_name} ${i.accept ? 'confirmed' : 'declined'} as ${cur.role.replace('_', ' ')} for ${ev.name}${i.reason ? `: ${i.reason}` : ''}.`, data: { crew_id: cur.id }, dedupe_key: `mr-crew-resp:${cur.id}:${row.status}:${uid}` });
    return withReady((await c.query(`SELECT ${CREW_VIEW} FROM ${CREW_FROM} WHERE c.id=$1`, [row.id])).rows[0]);
  }),
});

cap({
  name: 'release_crew_assignment', method: 'POST', path: '/media/crew/:id/release', tag: TAG,
  summary: 'End a production assignment (the history stays). The organiser can release anyone; a partner can release its own crew.',
  input: z.object({ id, reason: text(300).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const cur = (await c.query('SELECT * FROM mr_crew WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!cur) throw notFound('Assignment');
    const s = await standing(user, cur.event_id, c);
    if (!s.organiser && !s.acting.some((l) => l.id === cur.licence_id)) throw notFound('Assignment');
    if (cur.status === 'released') return cur;
    const row = (await c.query("UPDATE mr_crew SET status='released', updated_at=now() WHERE id=$1 RETURNING *", [cur.id])).rows[0];
    await logMr(c, cur.event_id, 'crew', cur.id, 'released', { actor: user.id, detail: { reason: i.reason ?? null } });
    await notify(c, cur.user_id, { kind: 'media_crew_released', title: 'Production assignment ended', body: `${s.ev.name}: your ${cur.role.replace('_', ' ')} assignment was released.`, data: { crew_id: cur.id }, dedupe_key: `mr-crew-rel:${cur.id}` });
    return row;
  }),
});

cap({
  name: 'list_media_crew', method: 'GET', path: '/events/:id/media/crew', tag: TAG,
  summary: 'Production crew of an event with their badge status (read live from the event department) and whether each is ready (confirmed and badge issued). The organiser sees everyone; a partner sees its own crew; crew see their own assignments.',
  input: z.object({ id, fixture_id: id.optional(), include_ended: z.coerce.boolean().default(false) }),
  async handler({ user }, i) {
    const s = await standing(user, i.id);
    needAny(s);
    const mine = s.licences.map((l) => l.id);
    const rows = await many(`SELECT ${CREW_VIEW} FROM ${CREW_FROM} WHERE c.event_id=$1 AND ($2::uuid IS NULL OR c.fixture_id=$2) AND ($3 OR c.status IN ('assigned','acknowledged'))
      AND ($4 OR c.user_id=$5 OR c.licence_id = ANY($6)) ORDER BY c.call_time NULLS LAST, u.display_name`, [i.id, i.fixture_id ?? null, i.include_ended, s.organiser, user.id, mine]);
    return rows.map(withReady);
  },
});

// ------------------------------------------------------------------ run sheet, call sheet, incidents
cap({
  name: 'save_run_item', method: 'POST', path: '/events/:id/media/run-sheet', tag: TAG, status: 201,
  summary: 'Add (or change) a run-sheet window for the production: setup, rehearsal, live or teardown, with start and end, the venue / resource / location and an optional game. Pass `item_id` to change or cancel one.',
  input: z.object({ id, item_id: id.optional(), phase: z.enum(['setup', 'rehearsal', 'live', 'teardown']), title: text(120).min(2), starts_at: dt, ends_at: dt, fixture_id: id.optional(), venue_id: id.optional(), resource_id: id.optional(), location: text(120).optional(), status: z.enum(['planned', 'done', 'cancelled']).default('planned') }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = await standing(user, i.id, c);
    if (!s.organiser && !s.acting.length) throw forbidden('Only the organiser, or a partner with rights in force, can edit the run sheet');
    if (new Date(i.ends_at) <= new Date(i.starts_at)) throw badRequest('The window must end after it starts');
    if (i.fixture_id && !(await c.query('SELECT 1 FROM fixtures WHERE id=$1 AND event_id=$2', [i.fixture_id, i.id])).rowCount) throw badRequest('Choose a game of this event');
    if (i.resource_id && !(await c.query('SELECT 1 FROM resources WHERE id=$1 AND ($2::uuid IS NULL OR venue_id=$2)', [i.resource_id, i.venue_id ?? null])).rowCount) throw badRequest('That resource is not at the venue');
    const v = [i.phase, i.title, i.starts_at, i.ends_at, i.fixture_id ?? null, i.venue_id ?? s.ev.venue_id ?? null, i.resource_id ?? null, i.location ?? null, i.status];
    let row;
    if (i.item_id) {
      row = (await c.query('UPDATE mr_run_items SET phase=$2, title=$3, starts_at=$4, ends_at=$5, fixture_id=$6, venue_id=$7, resource_id=$8, location=$9, status=$10 WHERE id=$1 AND event_id=$11 RETURNING *', [i.item_id, ...v, i.id])).rows[0];
      if (!row) throw notFound('Run-sheet item');
    } else row = (await c.query('INSERT INTO mr_run_items(event_id, created_by, phase, title, starts_at, ends_at, fixture_id, venue_id, resource_id, location, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *', [i.id, user.id, ...v])).rows[0];
    await logMr(c, i.id, 'run_item', row.id, i.item_id ? 'updated' : 'created', { actor: user.id, detail: { phase: row.phase, status: row.status } });
    return row;
  }),
});

const INC_VIEW = `n.id, n.event_id, n.fixture_id, n.kind, n.severity, n.summary, n.detail, n.status, n.created_at, n.resolved_at, u.display_name AS reported_by_name`;
cap({
  name: 'log_media_incident', method: 'POST', path: '/events/:id/media/incidents', tag: TAG, status: 201,
  summary: 'Record an operational incident or a change (feed lost, camera position moved, kick-off delayed, commentary booth swapped …) on the production. Anyone on the production of the event can log; the organiser is told when it is major or critical.',
  input: z.object({ id, kind: z.enum(['incident', 'change']), severity: z.enum(['info', 'minor', 'major', 'critical']).default('info'), summary: text(200).min(3), detail: text(2000).optional(), fixture_id: id.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = await standing(user, i.id, c);
    needAny(s);
    if (i.fixture_id && !(await c.query('SELECT 1 FROM fixtures WHERE id=$1 AND event_id=$2', [i.fixture_id, i.id])).rowCount) throw badRequest('Choose a game of this event');
    const row = (await c.query('INSERT INTO mr_incidents(event_id, fixture_id, kind, severity, summary, detail, reported_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [i.id, i.fixture_id ?? null, i.kind, i.severity, i.summary, i.detail ?? null, user.id])).rows[0];
    await logMr(c, i.id, 'incident', row.id, 'logged', { actor: user.id, detail: { severity: row.severity, kind: row.kind } });
    if (['major', 'critical'].includes(row.severity)) for (const uid of await eventOrganisers(c, s.ev)) await notify(c, uid, { kind: 'media_incident', title: `Production ${row.severity}: ${row.summary}`, body: `${s.ev.name} · ${row.kind}`, data: { incident_id: row.id, event_id: i.id }, dedupe_key: `mr-incident:${row.id}:${uid}` });
    return row;
  }),
});

cap({
  name: 'resolve_media_incident', method: 'POST', path: '/media/incidents/:id/resolve', tag: TAG,
  summary: 'Close an incident or change once handled. The organiser or the person who logged it can close it; it stays on record.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const cur = (await c.query('SELECT * FROM mr_incidents WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!cur) throw notFound('Incident');
    const s = await standing(user, cur.event_id, c);
    if (!s.organiser && cur.reported_by !== user.id) throw notFound('Incident');
    if (cur.status === 'resolved') return cur;
    const row = (await c.query("UPDATE mr_incidents SET status='resolved', resolved_by=$2, resolved_at=now() WHERE id=$1 RETURNING *", [cur.id, user.id])).rows[0];
    await logMr(c, cur.event_id, 'incident', cur.id, 'resolved', { actor: user.id });
    return row;
  }),
});

cap({
  name: 'get_call_sheet', method: 'GET', path: '/events/:id/media/call-sheet', tag: TAG,
  summary: 'The production call sheet / run sheet for an event or one game: windows in order (setup, rehearsal, live, teardown) with their place, crew with roles, call times, camera positions / booths and confirmation, the streams, and open incidents and changes. Only people on the production see it; contact details are never included.',
  input: z.object({ id, fixture_id: id.optional() }),
  async handler({ user }, i) {
    const s = await standing(user, i.id);
    needAny(s);
    const f = i.fixture_id ? (await one('SELECT f.id, f.scheduled_at, f.status, f.round, h.name AS home_name, a.name AS away_name FROM fixtures f LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id WHERE f.id=$1 AND f.event_id=$2', [i.fixture_id, i.id])) : null;
    if (i.fixture_id && !f) throw notFound('Game');
    const mine = s.licences.map((l) => l.id);
    const [run, crew, streams, incidents] = await Promise.all([
      many(`SELECT r.id, r.fixture_id, r.phase, r.title, r.starts_at, r.ends_at, r.location, r.status, r.resource_id, rs.name AS resource_name, v.name AS venue_name FROM mr_run_items r LEFT JOIN resources rs ON rs.id=r.resource_id LEFT JOIN venues v ON v.id=r.venue_id
        WHERE r.event_id=$1 AND ($2::uuid IS NULL OR r.fixture_id=$2 OR r.fixture_id IS NULL) AND r.status <> 'cancelled' ORDER BY r.starts_at`, [i.id, i.fixture_id ?? null]),
      many(`SELECT ${CREW_VIEW} FROM ${CREW_FROM} WHERE c.event_id=$1 AND ($2::uuid IS NULL OR c.fixture_id=$2 OR c.fixture_id IS NULL) AND c.status IN ('assigned','acknowledged') ORDER BY c.call_time NULLS LAST, u.display_name`, [i.id, i.fixture_id ?? null]),
      many("SELECT id, fixture_id, provider, state, scheduled_start, scheduled_end, access_policy, licence_id FROM mr_streams WHERE event_id=$1 AND ($2::uuid IS NULL OR fixture_id=$2 OR fixture_id IS NULL) AND status='active' ORDER BY scheduled_start NULLS LAST", [i.id, i.fixture_id ?? null]),
      many(`SELECT ${INC_VIEW} FROM mr_incidents n JOIN users u ON u.id=n.reported_by WHERE n.event_id=$1 AND ($2::uuid IS NULL OR n.fixture_id=$2 OR n.fixture_id IS NULL) AND n.status='open' ORDER BY n.created_at DESC`, [i.id, i.fixture_id ?? null]),
    ]);
    const me = crew.find((x) => x.user_id === user.id);
    return {
      event: { id: s.ev.id, name: s.ev.name, status: s.ev.status, venue_id: s.ev.venue_id }, fixture: f, run_sheet: run,
      crew: crew.map(withReady).map(({ user_id, ...x }) => ({ ...x, mine: user_id === user.id })), streams, incidents,
      readiness: { crew: crew.length, ready: crew.map(withReady).filter((x) => x.ready).length, unconfirmed: crew.filter((x) => x.status === 'assigned').length, no_badge: crew.filter((x) => x.accreditation !== 'issued').length, open_incidents: incidents.length },
      viewer: { organiser: s.organiser, partner: mine.length > 0, crew: !!me, my_assignment_id: me?.id ?? null },
    };
  },
});

// ------------------------------------------------------------------ streams
const STREAM_VIEW = `s.id, s.event_id, s.fixture_id, s.licence_id, s.provider, s.channel_ref, s.playback_ref, s.archive_ref, s.scheduled_start, s.scheduled_end, s.state, s.state_source, s.state_changed_at, s.access_policy, s.status`;
/** What the world is shown. A "live" report that has gone stale (well past the scheduled end) is shown as unconfirmed, never as live. */
const displayState = (s) => (s.state === 'live' && s.scheduled_end && Date.now() > new Date(s.scheduled_end).getTime() + 3 * 3600000 ? 'unconfirmed' : s.state);

cap({
  name: 'list_stream_providers', method: 'GET', path: '/media-stream-providers', tag: TAG, auth: 'public',
  summary: 'The external streaming / broadcast providers a stream can be associated with, and how each is connected in this deployment. Today every provider is a reference only: the organiser or partner supplies the stream reference and reports its state. SportArena does not host video, and never shows a stream as live on its own.',
  input: z.object({}),
  handler: async () => Object.entries(STREAM_PROVIDERS).map(([key, label]) => ({ key, label, integration: 'reference_only', state_reported_by: 'organiser_or_partner', credentials: 'never stored' })),
});

cap({
  name: 'save_stream', method: 'POST', path: '/events/:id/media/streams', tag: TAG, status: 201,
  summary: 'Associate an external stream with an event or one game: provider, the stream / channel reference, scheduled start and end, who may watch (public, subscribers, private) and optional playback and archive links (https). The organiser, or a partner whose licence carries video or audio rights, can do this. Provider credentials are never accepted or stored. Pass `stream_id` to change one.',
  input: z.object({ id, stream_id: id.optional(), provider: z.enum(Object.keys(STREAM_PROVIDERS)), channel_ref: text(300).min(1), playback_ref: https.optional(), archive_ref: https.optional(), scheduled_start: dt.optional(), scheduled_end: dt.optional(),
    access_policy: z.enum(['public', 'private', 'subscriber']).default('public'), fixture_id: id.optional(), licence_id: id.optional(), archived: z.boolean().optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = await standing(user, i.id, c);
    let lic = null;
    if (i.licence_id) {
      lic = (await c.query(`SELECT l.id, l.approved_rights FROM mr_licences l JOIN mr_packages p ON p.id=l.package_id JOIN media_partners m ON m.id=l.partner_id WHERE l.id=$1 AND p.event_id=$2 AND ${IN_FORCE()}`, [i.licence_id, i.id])).rows[0];
      if (!lic) throw badRequest('That licence is not in force for this event');
      if (!lic.approved_rights.some((r) => ['live_video', 'delayed_video', 'audio'].includes(r))) throw badRequest('That licence has no video or audio rights');
      if (!s.organiser && !s.acting.some((l) => l.id === lic.id)) throw forbidden('This is not your licence');
    } else if (!s.organiser) throw badRequest('Say which of your licences this stream is under');
    if (i.fixture_id && !(await c.query('SELECT 1 FROM fixtures WHERE id=$1 AND event_id=$2', [i.fixture_id, i.id])).rowCount) throw badRequest('Choose a game of this event');
    if (i.scheduled_start && i.scheduled_end && new Date(i.scheduled_end) <= new Date(i.scheduled_start)) throw badRequest('The stream must end after it starts');
    const v = [i.provider, i.channel_ref, i.playback_ref ?? null, i.archive_ref ?? null, i.scheduled_start ?? null, i.scheduled_end ?? null, i.access_policy, i.fixture_id ?? null, lic?.id ?? null];
    let row;
    if (i.stream_id) {
      const cur = (await c.query('SELECT * FROM mr_streams WHERE id=$1 AND event_id=$2 FOR UPDATE', [i.stream_id, i.id])).rows[0];
      if (!cur) throw notFound('Stream');
      if (!s.organiser && !s.acting.some((l) => l.id === cur.licence_id)) throw forbidden('This is not your stream');
      row = (await c.query("UPDATE mr_streams SET provider=$2, channel_ref=$3, playback_ref=$4, archive_ref=$5, scheduled_start=$6, scheduled_end=$7, access_policy=$8, fixture_id=$9, licence_id=$10, status=CASE WHEN $11::boolean THEN 'archived' ELSE 'active' END WHERE id=$1 RETURNING *", [cur.id, ...v, !!i.archived])).rows[0];
    } else row = (await c.query('INSERT INTO mr_streams(event_id, created_by, provider, channel_ref, playback_ref, archive_ref, scheduled_start, scheduled_end, access_policy, fixture_id, licence_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *', [i.id, user.id, ...v])).rows[0];
    await logMr(c, i.id, 'stream', row.id, i.stream_id ? 'updated' : 'created', { actor: user.id, detail: { provider: row.provider, access_policy: row.access_policy } });
    return { ...row, display_state: displayState(row), integration: 'reference_only' };
  }),
});

cap({
  name: 'set_stream_state', method: 'POST', path: '/media/streams/:id/state', tag: TAG,
  summary: 'Report the operational state of a stream: scheduled, live, offline or ended. This is a report by the organiser or the licensed partner, shown as such. A stream cannot be marked live without a playback link, nor while its licence is not in force. Add the archive link when it ends.',
  input: z.object({ id, state: z.enum(['scheduled', 'live', 'offline', 'ended']), playback_ref: https.optional(), archive_ref: https.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const cur = (await c.query('SELECT * FROM mr_streams WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!cur) throw notFound('Stream');
    const s = await standing(user, cur.event_id, c);
    if (!s.organiser && !s.acting.some((l) => l.id === cur.licence_id)) throw notFound('Stream');
    if (cur.status !== 'active') throw conflict('This stream is archived');
    const playback = i.playback_ref ?? cur.playback_ref;
    if (i.state === 'live') {
      if (!playback) throw badRequest('Add the playback link before marking a stream live', { code: 'playback_required' });
      if (cur.licence_id && !(await c.query(`SELECT 1 FROM mr_licences l JOIN mr_packages p ON p.id=l.package_id JOIN media_partners m ON m.id=l.partner_id WHERE l.id=$1 AND ${IN_FORCE()}`, [cur.licence_id])).rowCount) throw conflict('The licence for this stream is not in force');
      if (s.ev.status === 'cancelled') throw conflict('This event is cancelled');
    }
    const row = (await c.query('UPDATE mr_streams SET state=$2, state_source=\'organiser\', state_changed_at=now(), playback_ref=$3, archive_ref=coalesce($4, archive_ref) WHERE id=$1 RETURNING *', [cur.id, i.state, playback, i.archive_ref ?? null])).rows[0];
    await logMr(c, cur.event_id, 'stream', cur.id, `state_${i.state}`, { actor: user.id, detail: { from: cur.state } });
    return { ...row, display_state: displayState(row), reported_by: 'organiser_or_partner' };
  }),
});

cap({
  name: 'list_event_streams', method: 'GET', path: '/events/:id/media/streams', tag: TAG,
  summary: 'The streams associated with an event (all states), for the organiser and for partners and crew on the production.',
  input: z.object({ id, fixture_id: id.optional() }),
  async handler({ user }, i) {
    const s = await standing(user, i.id);
    needAny(s);
    const rows = await many(`SELECT ${STREAM_VIEW}, o.name AS partner_name FROM mr_streams s LEFT JOIN mr_licences l ON l.id=s.licence_id LEFT JOIN media_partners mp ON mp.id=l.partner_id LEFT JOIN organisations o ON o.id=mp.organisation_id
      WHERE s.event_id=$1 AND ($2::uuid IS NULL OR s.fixture_id=$2) AND s.status='active' AND ($3 OR s.licence_id = ANY($4) OR s.licence_id IS NULL) ORDER BY s.scheduled_start NULLS LAST`, [i.id, i.fixture_id ?? null, s.organiser, s.licences.map((l) => l.id)]);
    return rows.map((r) => ({ ...r, display_state: displayState(r), integration: 'reference_only', provider_label: STREAM_PROVIDERS[r.provider] }));
  },
});

cap({
  name: 'get_fixture_streams', method: 'GET', path: '/fixtures/:id/streams', tag: TAG, auth: 'public',
  summary: 'Where to watch a game, as far as it is actually configured: each stream\'s provider, schedule and reported state, and the playback link when the viewer is allowed to use it (public streams to everyone; subscriber and private streams only to the organiser, the licensed partner and the production). If nothing has been configured the list is empty: a stream is never implied.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const f = (await pool.query('SELECT f.id, f.event_id, e.status FROM fixtures f JOIN events e ON e.id=f.event_id WHERE f.id=$1', [i.id])).rows[0];
    if (!f) throw notFound('Game');
    const s = user ? await standing(user, f.event_id) : { organiser: false, licences: [], crew: false, any: false };
    if (f.status === 'draft' && !s.organiser) throw notFound('Game');
    const rows = await many(`SELECT ${STREAM_VIEW}, o.name AS partner_name FROM mr_streams s LEFT JOIN mr_licences l ON l.id=s.licence_id LEFT JOIN media_partners mp ON mp.id=l.partner_id LEFT JOIN organisations o ON o.id=mp.organisation_id
      WHERE s.event_id=$1 AND (s.fixture_id=$2 OR s.fixture_id IS NULL) AND s.status='active' ORDER BY s.scheduled_start NULLS LAST`, [f.event_id, i.id]);
    return rows.filter((r) => r.access_policy !== 'private' || s.any).map((r) => {
      const entitled = s.organiser || s.crew || s.licences.some((l) => l.id === r.licence_id);
      const watch = r.access_policy === 'public' || entitled;
      const { channel_ref, playback_ref, archive_ref, ...rest } = r;
      return { ...rest, display_state: displayState(r), provider_label: STREAM_PROVIDERS[r.provider], integration: 'reference_only', reported_by: 'organiser_or_partner',
        ...(watch ? { playback_ref: playback_ref ?? null, archive_ref: archive_ref ?? null } : { requires: r.access_policy === 'subscriber' ? 'subscription' : 'invitation' }), ...(entitled ? { channel_ref } : {}) };
    });
  },
});

cap({
  name: 'list_my_media_assignments', method: 'GET', path: '/me/media-assignments', tag: TAG,
  summary: 'Your own production assignments across events (upcoming first): role, event, game, call time, camera position / booth, whether you have confirmed, and your badge status read live from the event department. Past and released assignments are left out unless asked for.',
  input: z.object({ include_past: z.coerce.boolean().default(false), ...page }),
  handler: ({ user }, i) => many(
    `SELECT c.id, c.event_id, e.name AS event_name, e.status AS event_status, c.fixture_id, h.name AS home_name, a.name AS away_name, f.scheduled_at AS game_at, c.role, c.zones, c.call_time, c.camera_position, c.booth_ref, c.technical_provider, c.status, c.acknowledged_at,
            coalesce((SELECT m.accreditation FROM event_department_members m WHERE m.id=c.department_member_id), 'none') AS accreditation
       FROM mr_crew c JOIN events e ON e.id=c.event_id LEFT JOIN fixtures f ON f.id=c.fixture_id LEFT JOIN teams h ON h.id=f.home_team_id LEFT JOIN teams a ON a.id=f.away_team_id
      WHERE c.user_id=$1 AND ($2 OR (c.status IN ('assigned','acknowledged') AND coalesce(c.call_time, f.scheduled_at, now()) > now() - interval '1 day'))
      ORDER BY coalesce(c.call_time, f.scheduled_at) NULLS LAST LIMIT $3 OFFSET $4`, [user.id, i.include_past, i.limit, i.offset]),
});
