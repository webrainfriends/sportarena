// Team & delegation travel operations (#485), part 5: the daily movement board, disruption impact, travel incidents and audience-safe reports.
// There is no location tracking anywhere in this module: movements are the planned legs and check-in times the team recorded.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { many, pool, tx } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { ISSUE_LABEL, LIVE_PARTICIPANT, assertOpen, localDay, localText, readiness, record, tripCtx, youthIdsAmong } from '../trips.js';
import { costSummary } from '../trips-finance.js';

const TAG = 'Team travel';
const FIXTURE_BUFFER_H = 4;
const csvEsc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

const activeSegs = (tripId) => many(`SELECT s.*, (SELECT array_agg(sp.participant_id) FROM trip_segment_passengers sp WHERE sp.segment_id=s.id AND sp.removed_at IS NULL) AS pax FROM trip_segments s WHERE s.trip_id=$1 AND s.archived_at IS NULL AND s.status<>'cancelled' ORDER BY s.depart_at`, [tripId]);
const moveOut = (s) => ({ id: s.id, mode: s.mode, origin: s.origin, destination: s.destination, status: s.status, depart_local: localText(s.depart_at, s.depart_tz), depart_at: s.depart_at, depart_tz: s.depart_tz, arrive_local: localText(s.arrive_at, s.arrive_tz), arrive_at: s.arrive_at, arrive_tz: s.arrive_tz, meeting_point: s.meeting_point });

cap({
  name: 'get_trip_board', method: 'GET', path: '/trips/:id/board', tag: TAG,
  summary: 'The daily movement board. Trip staff get today and next movement, arrivals and departures, readiness and exceptions (unconfirmed travellers, missing documents or consent), recent transport / accommodation changes, equipment status, open incidents and linked supplier contacts. A traveller or guardian gets the personal version: their next movement, their own readiness and their own room. Planned times only; no live location.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ctx = await tripCtx(user, i.id);
    const { trip } = ctx, now = new Date(), today = localDay(now, trip.timezone);
    const segs = await activeSegs(trip.id);
    const r = await readiness(pool, trip);
    const mine = new Set([ctx.mine?.id, ...ctx.wards.map((w) => w.id)].filter(Boolean));
    const visible = segs.filter((s) => ctx.ops || (s.pax ?? []).some((p) => mine.has(p)));
    const upcoming = visible.filter((s) => Date.parse(s.arrive_at) >= now.getTime());
    const base = {
      trip: { id: trip.id, name: trip.name, status: trip.status, timezone: trip.timezone, today, now_local: localText(now, trip.timezone) },
      next_movement: upcoming[0] ? moveOut(upcoming[0]) : null,
      today_movements: visible.filter((s) => localDay(s.depart_at, s.depart_tz) === today || localDay(s.arrive_at, s.arrive_tz) === today).map(moveOut),
    };
    if (!ctx.ops) {
      const own = [...r.byId.values()].filter((x) => mine.has(x.participant.id));
      return { ...base, scope: 'personal', readiness: own.map((x) => ({ participant_id: x.participant.id, display_name: x.participant.display_name, ready: x.ready, issues: x.issues.map((code) => ({ code, label: ISSUE_LABEL[code] })) })) };
    }
    const all = [...r.byId.values()];
    const stays = await many("SELECT id, property_name, status, check_in_at, check_out_at, tz FROM trip_stays WHERE trip_id=$1 AND archived_at IS NULL AND status<>'cancelled' ORDER BY check_in_at", [trip.id]);
    const changes = await many(`SELECT ch.entity, ch.action, ch.note, ch.created_at, u.display_name AS actor_name FROM trip_changes ch LEFT JOIN users u ON u.id=ch.actor_id WHERE ch.trip_id=$1 AND ch.entity IN ('segment','stay','participant','room','trip') AND ch.created_at > now() - interval '72 hours' ORDER BY ch.created_at DESC LIMIT 15`, [trip.id]);
    const gear = await many("SELECT state, count(*)::int AS n, coalesce(sum(quantity),0)::int AS items FROM trip_gear WHERE trip_id=$1 AND archived_at IS NULL GROUP BY state", [trip.id]);
    const gearBad = await many("SELECT id, description, quantity, state FROM trip_gear WHERE trip_id=$1 AND archived_at IS NULL AND state IN ('missing','damaged')", [trip.id]);
    const incidents = await many("SELECT i.id, i.kind, i.summary, i.created_at, p.id AS participant_id FROM trip_incidents i LEFT JOIN trip_participants p ON p.id=i.participant_id WHERE i.trip_id=$1 AND i.status='open' ORDER BY i.created_at", [trip.id]);
    const suppliers = await many(`SELECT l.purpose, o.number AS order_number, o.status AS order_status, coalesce(sp.trading_name, sp.legal_name) AS supplier_name, o.id AS order_id FROM trip_supplier_links l JOIN svc_orders o ON o.id=l.order_id LEFT JOIN svc_profiles sp ON sp.id=o.profile_id WHERE l.trip_id=$1 AND l.unlinked_at IS NULL`, [trip.id]);
    const exceptions = all.filter((x) => !x.ready).map((x) => ({ participant_id: x.participant.id, display_name: x.participant.display_name, role: x.participant.role, young: x.youth, issues: x.issues.map((code) => ({ code, label: ISSUE_LABEL[code] })) }));
    return {
      ...base, scope: 'manager',
      counts: { party: all.length, ready: all.filter((x) => x.ready).length, unconfirmed: all.filter((x) => x.issues.includes('unconfirmed')).length, missing_documents: all.filter((x) => x.issues.some((c) => ['passport_missing', 'passport_expiry', 'visa_pending'].includes(c))).length, missing_consent: all.filter((x) => x.issues.includes('guardian_travel_consent')).length },
      arrivals: segs.filter((s) => localDay(s.arrive_at, s.arrive_tz) === today).map(moveOut), departures: segs.filter((s) => localDay(s.depart_at, s.depart_tz) === today).map(moveOut),
      check_ins: stays.filter((s) => localDay(s.check_in_at, s.tz) === today).map((s) => ({ stay_id: s.id, property_name: s.property_name, check_in_local: localText(s.check_in_at, s.tz) })),
      check_outs: stays.filter((s) => localDay(s.check_out_at, s.tz) === today).map((s) => ({ stay_id: s.id, property_name: s.property_name, check_out_local: localText(s.check_out_at, s.tz) })),
      exceptions, recent_changes: changes, equipment: { by_state: gear, problems: gearBad }, open_incidents: incidents, suppliers,
    };
  },
});

cap({
  name: 'get_trip_readiness', method: 'GET', path: '/trips/:id/readiness', tag: TAG,
  summary: 'Readiness per traveller with the reasons (unconfirmed, guardian trip consent, chaperone, passport, visa, transport, room). Derived live from the records. Trip staff see everyone; a traveller or guardian sees only their own.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ctx = await tripCtx(user, i.id);
    const mine = new Set([ctx.mine?.id, ...ctx.wards.map((w) => w.id)].filter(Boolean));
    const r = await readiness(pool, ctx.trip);
    return [...r.byId.values()].filter((x) => ctx.ops || mine.has(x.participant.id)).map((x) => ({ participant_id: x.participant.id, display_name: x.participant.display_name, role: x.participant.role, status: x.participant.status, young: x.youth, ready: x.ready, issues: x.issues.map((code) => ({ code, label: ISSUE_LABEL[code] })) }));
  },
});

cap({
  name: 'get_trip_impact', method: 'GET', path: '/trips/:id/impact', tag: TAG,
  summary: 'Impact view for a delayed or cancelled leg: who is on it, the linked fixtures that start within a few hours of its arrival (or before it), the stays whose check-in it touches and the equipment riding on it. Read-only: a travel change never edits a canonical fixture; the organiser decides about the fixture.',
  input: z.object({ id, segment_id: id, buffer_hours: z.coerce.number().min(0).max(168).default(FIXTURE_BUFFER_H) }),
  async handler({ user }, i) {
    const ctx = await tripCtx(user, i.id);
    if (!ctx.ops) throw forbidden('Only trip staff can see the impact view');
    const s = (await pool.query('SELECT * FROM trip_segments WHERE id=$1 AND trip_id=$2', [i.segment_id, ctx.trip.id])).rows[0];
    if (!s) throw notFound('Segment');
    const people = await many(`SELECT p.id AS participant_id, p.role, u.display_name FROM trip_segment_passengers sp JOIN trip_participants p ON p.id=sp.participant_id JOIN users u ON u.id=p.user_id WHERE sp.segment_id=$1 AND sp.removed_at IS NULL`, [s.id]);
    const fixtures = await many(
      `SELECT f.id AS fixture_id, f.scheduled_at, f.round, e.name AS event_name, ht.name AS home_name, at.name AS away_name FROM trip_events l JOIN fixtures f ON f.id=l.fixture_id JOIN events e ON e.id=f.event_id LEFT JOIN teams ht ON ht.id=f.home_team_id LEFT JOIN teams at ON at.id=f.away_team_id
        WHERE l.trip_id=$1 AND l.unlinked_at IS NULL AND f.status='scheduled' AND f.scheduled_at > $2 ORDER BY f.scheduled_at`, [ctx.trip.id, s.depart_at]);
    const buffer = i.buffer_hours * 36e5;
    const stays = await many("SELECT id, property_name, check_in_at, tz FROM trip_stays WHERE trip_id=$1 AND archived_at IS NULL AND status<>'cancelled' AND check_in_at BETWEEN $2::timestamptz - interval '1 day' AND $2::timestamptz + interval '1 day'", [ctx.trip.id, s.arrive_at]);
    const gear = await many('SELECT id, description, quantity, state FROM trip_gear WHERE trip_id=$1 AND segment_id=$2 AND archived_at IS NULL', [ctx.trip.id, s.id]);
    return {
      segment: moveOut(s), travellers: people,
      fixtures_at_risk: fixtures.map((f) => ({ ...f, slack_minutes: Math.round((Date.parse(f.scheduled_at) - Date.parse(s.arrive_at)) / 60000) })).filter((f) => f.slack_minutes * 60000 < buffer || s.status === 'cancelled'),
      stays_touched: stays.map((st) => ({ ...st, check_in_local: localText(st.check_in_at, st.tz) })), equipment: gear,
      note: 'Fixtures are shown for reference only. Travel changes never modify a fixture; contact the event organiser if a fixture needs to move.',
    };
  },
});

// ---------------------------------------------------------------- incidents

cap({
  name: 'add_trip_incident', method: 'POST', path: '/trips/:id/incidents', tag: TAG, status: 201,
  summary: 'Report a travel incident (delay, medical, safeguarding, lost item, security, other). Keep the summary operational: no diagnosis, document numbers or detail about other people. Any traveller (or guardian) may report; trip staff are told, and a safeguarding report goes only to the manager and the owning team / organisation approvers.',
  input: z.object({ id, kind: z.enum(['delay', 'medical', 'safeguarding', 'lost_item', 'security', 'other']), summary: z.string().trim().min(2).max(300), participant_id: id.optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      assertOpen(ctx.trip);
      if (i.participant_id && !(await c.query('SELECT 1 FROM trip_participants WHERE id=$1 AND trip_id=$2', [i.participant_id, ctx.trip.id])).rowCount) throw badRequest('That traveller is not on this trip');
      const row = (await c.query('INSERT INTO trip_incidents(trip_id, kind, summary, participant_id, reported_by) VALUES ($1,$2,$3,$4,$5) RETURNING *', [ctx.trip.id, i.kind, i.summary, i.participant_id ?? null, user.id])).rows[0];
      const staff = (await c.query("SELECT user_id FROM trip_participants WHERE trip_id=$1 AND status='confirmed' AND role IN ('manager','chaperone')", [ctx.trip.id])).rows.map((r) => r.user_id);
      await record(c, ctx.trip, user.id, { entity: 'incident', entityId: row.id, action: 'reported', snapshot: { kind: i.kind }, affected: i.kind === 'safeguarding' ? [ctx.trip.manager_id] : [ctx.trip.manager_id, ...staff], title: `Trip incident: ${i.kind.replace('_', ' ')}`, body: ctx.trip.name });
      return row;
    });
  },
});

cap({
  name: 'resolve_trip_incident', method: 'POST', path: '/trips/:id/incidents/:incident_id/resolve', tag: TAG,
  summary: 'Trip staff: close a travel incident with a short resolution. The incident stays in the history.',
  input: z.object({ id, incident_id: id, resolution: z.string().trim().min(2).max(300) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const ctx = await tripCtx(user, i.id, c, { lock: true });
      if (!ctx.ops) throw forbidden('Only trip staff can resolve incidents');
      const row = (await c.query("UPDATE trip_incidents SET status='resolved', resolved_by=$3, resolved_at=now(), resolution=$4 WHERE id=$1 AND trip_id=$2 AND status='open' RETURNING *", [i.incident_id, ctx.trip.id, user.id, i.resolution])).rows[0];
      if (!row) throw notFound('Open incident');
      await record(c, ctx.trip, user.id, { entity: 'incident', entityId: row.id, action: 'resolved', note: i.resolution });
      return row;
    });
  },
});

cap({
  name: 'list_trip_incidents', method: 'GET', path: '/trips/:id/incidents', tag: TAG,
  summary: 'Travel incidents. Trip staff see all; anyone else sees only what they reported.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const ctx = await tripCtx(user, i.id);
    return many('SELECT id, kind, summary, status, participant_id, resolution, created_at, resolved_at FROM trip_incidents WHERE trip_id=$1 AND ($2 OR reported_by=$3) ORDER BY created_at DESC', [ctx.trip.id, ctx.ops, user.id]);
  },
});

// ---------------------------------------------------------------- reports

const KINDS = ['manifest', 'itinerary', 'rooming', 'movement', 'equipment', 'readiness', 'cost'];
const AUDIENCES = ['manager', 'traveller', 'supplier'];

cap({
  name: 'get_trip_report', method: 'GET', path: '/trips/:id/reports/:kind', tag: TAG,
  summary: 'Travel manifest, itinerary, rooming list, movement plan, equipment manifest, readiness exceptions or cost summary, as rows plus CSV. Audience-safe: manager (trip staff, full), traveller (your own rows only) or supplier (trip staff only; adult travellers by name, young travellers counted only, no rooms, documents or money). Every export is audit-logged and marked with an expiry; it inherits the source records\' permissions.',
  input: z.object({ id, kind: z.enum(KINDS), audience: z.enum(AUDIENCES).default('manager') }),
  async handler({ user }, i) {
    const ctx = await tripCtx(user, i.id);
    if (i.audience !== 'traveller' && !ctx.ops) throw forbidden('Only trip staff can export the full or supplier version');
    if (i.audience === 'supplier' && ['rooming', 'readiness', 'cost'].includes(i.kind)) throw badRequest('That report is not available in the supplier version');
    if (i.kind === 'cost' && !ctx.ops) throw forbidden('Only trip staff can export the cost summary');
    const { trip } = ctx;
    const mine = new Set([ctx.mine?.id, ...ctx.wards.map((w) => w.id)].filter(Boolean));
    const personal = i.audience === 'traveller';
    const parts = await many(`SELECT p.id, p.user_id, p.role, p.status, u.display_name FROM trip_participants p JOIN users u ON u.id=p.user_id WHERE p.trip_id=$1 AND p.status = ANY($2) ORDER BY p.created_at`, [trip.id, LIVE_PARTICIPANT]);
    const youth = new Set(await youthIdsAmong(pool, parts.map((p) => p.user_id)));
    const nameOf = (p) => (i.audience === 'supplier' && youth.has(p.user_id) ? null : p.display_name);
    let columns, rows;
    if (i.kind === 'manifest') {
      columns = ['name', 'role', 'status']; const list = parts.filter((p) => !personal || mine.has(p.id));
      rows = list.filter((p) => !(i.audience === 'supplier' && youth.has(p.user_id))).map((p) => [p.display_name, p.role, p.status]);
      if (i.audience === 'supplier') { const n = list.filter((p) => youth.has(p.user_id)).length; if (n) rows.push([`${n} young traveller${n === 1 ? '' : 's'} (names withheld)`, 'athlete', 'counted only']); }
    } else if (i.kind === 'itinerary' || i.kind === 'movement') {
      const segs = (await activeSegs(trip.id)).filter((s) => !personal || (s.pax ?? []).some((p) => mine.has(p)));
      columns = ['departs (local)', 'zone', 'from', 'to', 'arrives (local)', 'zone', 'mode', 'status', 'meeting point'];
      rows = segs.map((s) => [localText(s.depart_at, s.depart_tz), s.depart_tz, s.origin, s.destination, localText(s.arrive_at, s.arrive_tz), s.arrive_tz, s.mode, s.status, s.meeting_point ?? '']);
      if (i.kind === 'movement') {
        const stays = await many("SELECT property_name, check_in_at, check_out_at, tz FROM trip_stays WHERE trip_id=$1 AND archived_at IS NULL AND status<>'cancelled'", [trip.id]);
        for (const st of stays) rows.push([localText(st.check_in_at, st.tz), st.tz, '', st.property_name, '', '', 'check-in', '', '']);
        rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      }
    } else if (i.kind === 'rooming') {
      if (personal) throw badRequest('Use the Stay screen for your own room');
      columns = ['property', 'room', 'type', 'traveller', 'young'];
      const rr = await many(`SELECT s.property_name, r.label, r.room_type, u.display_name, p.user_id FROM trip_rooms r JOIN trip_stays s ON s.id=r.stay_id LEFT JOIN trip_room_assignments a ON a.room_id=r.id AND a.released_at IS NULL LEFT JOIN trip_participants p ON p.id=a.participant_id LEFT JOIN users u ON u.id=p.user_id WHERE s.trip_id=$1 AND r.archived_at IS NULL ORDER BY s.property_name, r.label NULLS LAST`, [trip.id]);
      rows = rr.map((r) => [r.property_name, r.label ?? '', r.room_type, r.display_name ?? '(empty)', r.user_id && youth.has(r.user_id) ? 'yes' : '']);
    } else if (i.kind === 'equipment') {
      columns = ['item', 'category', 'quantity', 'state', 'responsible', 'logistics ref'];
      const g = await many('SELECT g.description, g.category, g.quantity, g.state, u.display_name, g.logistics_ref, g.responsible_id FROM trip_gear g LEFT JOIN users u ON u.id=g.responsible_id WHERE g.trip_id=$1 AND g.archived_at IS NULL ORDER BY g.created_at', [trip.id]);
      rows = g.filter((x) => !personal || x.responsible_id === user.id).map((x) => [x.description, x.category, x.quantity, x.state, x.display_name ?? '', x.logistics_ref ?? '']);
    } else if (i.kind === 'readiness') {
      columns = ['traveller', 'role', 'ready', 'open items'];
      const r = await readiness(pool, trip);
      rows = [...r.byId.values()].filter((x) => !personal || mine.has(x.participant.id)).map((x) => [x.participant.display_name, x.participant.role, x.ready ? 'yes' : 'no', x.issues.map((c) => ISSUE_LABEL[c]).join('; ')]);
    } else {
      columns = ['currency', 'supplier orders (gross)', 'per diem entitlement', 'per diem paid', 'advances paid', 'claims pending', 'claims approved', 'claims reimbursed'];
      const m = (n) => (n / 100).toFixed(2);
      rows = (await costSummary(pool, trip)).map((x) => [x.currency, m(x.supplier_orders_gross_minor), m(x.per_diem_entitlement_minor), m(x.per_diem_paid_minor), m(x.advances_minor), m(x.claims_pending_minor), m(x.claims_approved_minor), m(x.claims_reimbursed_minor)]);
    }
    await audit(null, user.id, `export_trip_report_${i.kind}_${i.audience}`, 'trips', trip.id);
    const expires = new Date(Date.now() + 24 * 36e5).toISOString();
    const title = `${trip.name} — ${i.kind}`;
    return { title, kind: i.kind, audience: i.audience, generated_at: new Date().toISOString(), expires_at: expires, timezone_note: 'Times are local to the place named; zones are shown beside them.', columns, rows,
      csv: [columns.map(csvEsc).join(','), ...rows.map((r) => r.map(csvEsc).join(','))].join('\n'), filename: `${trip.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${i.kind}-${i.audience}.csv` };
  },
});
