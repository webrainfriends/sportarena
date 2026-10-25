// Supplier services (#458) 5/5a — scheduling, work orders (visits), attendance, incidents and buyer acceptance.
// A supplier can never accept its own work; acceptance caps billing; occurrence keys make regeneration and retries idempotent.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { supplierAccess, buyerAccess, myProfileIds, myBuyerIds, log } from '../svc/access.js';
import { loadOrder, orderSide, anySide, isOwnSupplier, refreshOrder, q1 } from '../svc/orders.js';
import { isYouth, hasConsent } from '../youth.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { supplierAudience, buyerAudience } from './svc-rfq.js';

const TAG = 'Service fulfilment';
const ts = z.string().datetime({ offset: true });
const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const tell = async (c, users, msg, actor) => { for (const u of new Set(users)) if (u !== actor) await notify(c, u, msg); };

/** Overlaps with other visits at the same site, or with the same people (plus a travel buffer). Cancelled / rejected visits never conflict. */
async function conflicts(c, { profileId, resourceKey, assignees, startsAt, endsAt, bufferMin = 0, exceptVisit = null }) {
  const out = [];
  const buf = `${Math.max(0, bufferMin)} minutes`;
  if (resourceKey) for (const r of (await c.query("SELECT v.id, v.starts_at, v.ends_at FROM svc_visits v WHERE v.resource_key=$1 AND v.status NOT IN ('cancelled','rejected','no_show') AND v.id IS DISTINCT FROM $4 AND v.starts_at < $3 AND v.ends_at > $2", [resourceKey, startsAt, endsAt, exceptVisit])).rows) out.push({ kind: 'site', visit_id: r.id, starts_at: r.starts_at });
  if (assignees?.length) for (const r of (await c.query("SELECT v.id, v.starts_at FROM svc_visits v JOIN svc_orders o ON o.id=v.order_id WHERE o.profile_id=$1 AND v.assignees && $2::uuid[] AND v.status NOT IN ('cancelled','rejected','no_show') AND v.id IS DISTINCT FROM $5 AND v.starts_at < ($4::timestamptz + $6::interval) AND v.ends_at > ($3::timestamptz - $6::interval)", [profileId, assignees, startsAt, endsAt, exceptVisit, buf])).rows) out.push({ kind: 'person', visit_id: r.id, starts_at: r.starts_at });
  return out;
}
/** Crew rules: under-18s only where the requirement says so AND an active participation consent exists; anything else is refused. */
async function checkCrew(c, order, assignees) {
  for (const u of assignees ?? []) {
    if (!(await c.query('SELECT 1 FROM users WHERE id=$1', [u])).rowCount) throw notFound('Crew member');
    if (await isYouth(u, c)) {
      const sc = (await q1(c, "SELECT r.scope->'scope' AS s FROM svc_rfqs r WHERE r.id=$1", [order.rfq_id]))?.s ?? {};
      if (!sc.includes_minors) throw conflict('This order does not allow under-18 crew');
      if (!(await hasConsent(u, 'participation', c))) throw conflict('A guardian’s participation consent is needed before an under-18 can be assigned');
    }
  }
}

cap({
  name: 'generate_service_visits', method: 'POST', path: '/service-orders/:id/visits', tag: TAG, status: 201,
  summary: 'Supplier scheduler: create visits / shifts for an order line — one-off or recurring (daily, weekly on given days, monthly until a date). Each occurrence has a deterministic key, so regenerating or retrying never duplicates a visit; planned quantity can never exceed what was ordered. Site and crew conflicts (with a travel buffer) are reported and refused.',
  input: z.object({ id, line_no: z.number().int().positive(), starts_at: ts, duration_minutes: z.number().int().min(5).max(24 * 60), planned_qty: z.number().positive().max(1e6), recurrence: z.object({ freq: z.enum(['daily', 'weekly', 'monthly']), by_day: z.array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])).max(7).optional(), until: z.string().date() }).optional(),
    resource_key: z.string().max(80).optional(), site_label: z.string().max(160).optional(), supervisor_id: z.string().uuid().optional(), assignees: z.array(z.string().uuid()).max(100).default([]), travel_buffer_minutes: z.number().int().min(0).max(240).default(0), checklist: z.array(z.object({ task: z.string().min(1).max(200), done: z.boolean().default(false) })).max(50).default([]) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const o = await loadOrder(c, i.id, { lock: true });
      const { sup } = await orderSide(user, o, { buyer: false, supplier: ['owner', 'scheduler'] }, c);
      if (!sup) throw notFound('Order');
      if (!['confirmed', 'in_progress'].includes(o.status)) throw conflict(`Order is ${o.status}; only confirmed orders can be scheduled`);
      const line = await q1(c, "SELECT * FROM svc_order_lines WHERE order_id=$1 AND line_no=$2 AND status='active' FOR UPDATE", [o.id, i.line_no]);
      if (!line) throw notFound('Order line');
      await checkCrew(c, o, [...i.assignees, ...(i.supervisor_id ? [i.supervisor_id] : [])]);
      const start0 = new Date(i.starts_at);
      const dates = [];
      if (!i.recurrence) dates.push(start0);
      else {
        const until = new Date(`${i.recurrence.until}T23:59:59Z`).getTime();
        for (let t = start0.getTime(); t <= until && dates.length < 400; t += 86400000) {
          const d = new Date(t);
          if (i.recurrence.freq === 'daily' || (i.recurrence.freq === 'weekly' && (i.recurrence.by_day?.length ? i.recurrence.by_day.includes(DOW[d.getUTCDay()]) : d.getUTCDay() === start0.getUTCDay())) || (i.recurrence.freq === 'monthly' && d.getUTCDate() === start0.getUTCDate())) dates.push(d);
        }
      }
      if (!dates.length) throw badRequest('That recurrence produces no visits');
      const planned = Number((await q1(c, "SELECT coalesce(sum(planned_qty),0) AS s FROM svc_visits WHERE line_id=$1 AND status NOT IN ('cancelled','rejected','no_show')", [line.id])).s);
      const existingKeys = new Set((await c.query('SELECT occurrence_key FROM svc_visits WHERE order_id=$1 AND line_id=$2', [o.id, line.id])).rows.map((r) => r.occurrence_key));
      const fresh = dates.filter((d) => !existingKeys.has(`${i.line_no}:${d.toISOString()}`));
      if (planned + fresh.length * i.planned_qty > Number(line.qty_ordered) + 1e-9) throw conflict(`That would plan more than was ordered (${Number(line.qty_ordered) - planned} left on line ${i.line_no})`);
      const made = []; const clashes = [];
      for (const d of fresh) {
        const end = new Date(d.getTime() + i.duration_minutes * 60000);
        const who = [...i.assignees, ...(i.supervisor_id ? [i.supervisor_id] : [])];
        const cf = await conflicts(c, { profileId: o.profile_id, resourceKey: i.resource_key, assignees: who, startsAt: d.toISOString(), endsAt: end.toISOString(), bufferMin: i.travel_buffer_minutes });
        if (cf.length) { clashes.push({ starts_at: d.toISOString(), conflicts: cf }); continue; }
        const v = (await c.query("INSERT INTO svc_visits(order_id, line_id, occurrence_key, site_label, resource_key, starts_at, ends_at, planned_qty, supervisor_id, assignees, checklist, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'scheduled') ON CONFLICT (order_id, occurrence_key) DO NOTHING RETURNING *",
          [o.id, line.id, `${i.line_no}:${d.toISOString()}`, i.site_label ?? null, i.resource_key ?? null, d.toISOString(), end.toISOString(), i.planned_qty, i.supervisor_id ?? null, i.assignees, JSON.stringify(i.checklist)])).rows[0];
        if (v) made.push(v);
      }
      if (clashes.length) throw conflict('Some visits clash with existing bookings; nothing was created', { clashes });
      await refreshOrder(c, o.id);
      return { created: made.length, skipped_existing: dates.length - fresh.length, visits: made };
    });
  },
});

const visitFor = async (c, id0, lock = true) => {
  const v = await q1(c, `SELECT * FROM svc_visits WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [id0]);
  if (!v) throw notFound('Visit');
  return { v, o: await loadOrder(c, v.order_id) };
};
const redactCrew = async (c, ids) => {                               // buyers see headcount and initials for minors, never their names or contacts
  const out = [];
  for (const u of ids ?? []) { const r = await q1(c, 'SELECT display_name FROM users WHERE id=$1', [u]); const minor = await isYouth(u, c); out.push({ ref: u.slice(0, 8), label: minor ? (r?.display_name ?? '?').split(/\s+/).map((x) => x[0]).join('.').toUpperCase() : r?.display_name, minor }); }
  return out;
};

cap({
  name: 'list_service_visits', method: 'GET', path: '/service-orders/:id/visits', tag: TAG,
  summary: 'Visits of an order. The supplier sees its crew; the buyer sees headcount and (for under-18s) initials only.',
  input: z.object({ id, status: z.string().optional(), ...page }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const o = await loadOrder(c, i.id);
      const { sup } = await anySide(user, o, c);
      const rows = (await c.query('SELECT * FROM svc_visits WHERE order_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY starts_at, id LIMIT $3 OFFSET $4', [o.id, i.status ?? null, i.limit, i.offset])).rows;
      if (sup) return rows;
      const out = [];
      for (const v of rows) { const { assignees, supervisor_id, ...rest } = v; out.push({ ...rest, crew_count: assignees.length, crew: await redactCrew(c, assignees), has_supervisor: !!supervisor_id }); }
      if (out.some((v) => v.crew.some((x) => x.minor))) await audit(c, user.id, 'read_pii', 'svc_visits', o.id);
      return out;
    });
  },
});
cap({
  name: 'get_supplier_calendar', method: 'GET', path: '/supplier-profiles/:id/calendar', tag: TAG,
  summary: 'Supplier calendar: visits and blackout days in a window, across all orders (staff only).',
  input: z.object({ id, from: z.string().date(), to: z.string().date() }),
  async handler({ user }, i) {
    await supplierAccess(user, i.id, ['owner', 'scheduler', 'supervisor', 'sales']);
    if (i.to < i.from || (new Date(i.to) - new Date(i.from)) / 86400000 > 93) throw badRequest('Ask for at most 93 days');
    const [visits, blackouts] = await Promise.all([
      many("SELECT v.id, v.order_id, o.number, v.starts_at, v.ends_at, v.status, v.site_label, v.resource_key, array_length(v.assignees,1) AS crew FROM svc_visits v JOIN svc_orders o ON o.id=v.order_id WHERE o.profile_id=$1 AND v.starts_at >= $2::date AND v.starts_at < $3::date + 1 AND v.status <> 'cancelled' ORDER BY v.starts_at, v.id", [i.id, i.from, i.to]),
      many('SELECT day, reason FROM svc_blackouts WHERE profile_id=$1 AND day BETWEEN $2 AND $3 ORDER BY day', [i.id, i.from, i.to]),
    ]);
    return { visits, blackouts };
  },
});
cap({
  name: 'get_buyer_calendar', method: 'GET', path: '/service-buyers/:id/calendar', tag: TAG,
  summary: 'Timeline of preparation, delivery, maintenance and teardown across the procurement context, with site conflicts flagged. A maintenance booking records work; it does not certify a venue as safe.',
  input: z.object({ id, from: z.string().date(), to: z.string().date() }),
  async handler({ user }, i) {
    await buyerAccess(user, i.id, null);
    if (i.to < i.from || (new Date(i.to) - new Date(i.from)) / 86400000 > 93) throw badRequest('Ask for at most 93 days');
    const visits = await many("SELECT v.id, v.order_id, o.number, v.starts_at, v.ends_at, v.status, v.site_label, v.resource_key, r.scope->>'category' AS category FROM svc_visits v JOIN svc_orders o ON o.id=v.order_id LEFT JOIN svc_rfqs r ON r.id=o.rfq_id WHERE o.buyer_id=$1 AND v.starts_at >= $2::date AND v.starts_at < $3::date + 1 AND v.status <> 'cancelled' ORDER BY v.starts_at, v.id", [i.id, i.from, i.to]);
    const clashes = [];
    for (let a = 0; a < visits.length; a++) for (let b = a + 1; b < visits.length; b++) if (visits[a].resource_key && visits[a].resource_key === visits[b].resource_key && new Date(visits[a].starts_at) < new Date(visits[b].ends_at) && new Date(visits[b].starts_at) < new Date(visits[a].ends_at)) clashes.push([visits[a].id, visits[b].id]);
    return { visits, clashes, disclaimer: 'A maintenance booking records work done; it is not a safety certificate.' };
  },
});

const FLOW = { planned: ['confirmed', 'scheduled', 'cancelled'], confirmed: ['scheduled', 'in_progress', 'cancelled', 'paused'], scheduled: ['in_progress', 'cancelled', 'paused', 'no_show'], in_progress: ['submitted_for_acceptance', 'paused', 'cancelled'], paused: ['scheduled', 'cancelled'], rework: ['in_progress', 'submitted_for_acceptance', 'cancelled'], rejected: ['rework'] };
cap({
  name: 'update_service_visit', method: 'POST', path: '/service-visits/:id/status', tag: TAG,
  summary: 'Supplier supervisor/scheduler: move a visit along (scheduled → in progress → submitted for acceptance; paused, cancelled, no-show). Completion needs the actual quantity; checklist, test readings and evidence references are kept with it. Readings are recorded evidence only — they do not certify compliance.',
  input: z.object({ id, row_version: z.number().int(), status: z.enum(['confirmed', 'scheduled', 'in_progress', 'submitted_for_acceptance', 'paused', 'cancelled', 'no_show']), actual_qty: z.number().positive().max(1e6).optional(), checklist: z.array(z.object({ task: z.string().max(200), done: z.boolean() })).max(50).optional(), readings: z.array(z.object({ name: z.string().max(80), value: z.number(), unit: z.string().max(20), at: ts.optional() })).max(50).optional(), evidence: z.array(z.object({ ref: z.string().max(300), caption: z.string().max(200).optional() })).max(20).optional(), notes: z.string().max(2000).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { v, o } = await visitFor(c, i.id);
      const { sup } = await orderSide(user, o, { buyer: false, supplier: ['owner', 'scheduler', 'supervisor'] }, c);
      if (!sup) throw notFound('Visit');
      if (v.row_version !== i.row_version) throw conflict('This visit changed since you opened it — reload and try again');
      if (!(FLOW[v.status] ?? []).includes(i.status)) throw conflict(`A ${v.status} visit cannot become ${i.status}`);
      if (['paused'].includes(o.status) && i.status === 'in_progress') throw conflict('The order is paused');
      if (i.status === 'submitted_for_acceptance' && !(i.actual_qty ?? v.actual_qty)) throw badRequest('Say how much was actually done');
      if (i.status === 'submitted_for_acceptance') {
        const line = await q1(c, 'SELECT * FROM svc_order_lines WHERE id=$1', [v.line_id]);
        const pend = Number((await q1(c, "SELECT coalesce(sum(coalesce(actual_qty, planned_qty)),0) AS s FROM svc_visits WHERE line_id=$1 AND status IN ('submitted_for_acceptance') AND id <> $2", [v.line_id, v.id])).s);
        if (Number(line.qty_accepted) + pend + Number(i.actual_qty ?? v.actual_qty) > Number(line.qty_ordered) + 1e-9) throw conflict('That is more than was ordered; ask the buyer for a variation first');
      }
      const row = await q1(c, 'UPDATE svc_visits SET status=$2, actual_qty=coalesce($3, actual_qty), checklist=coalesce($4, checklist), readings=coalesce($5, readings), evidence=coalesce($6, evidence), notes=coalesce($7, notes), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *',
        [v.id, i.status, i.actual_qty ?? null, i.checklist ? JSON.stringify(i.checklist) : null, i.readings ? JSON.stringify(i.readings) : null, i.evidence ? JSON.stringify(i.evidence) : null, i.notes ?? null]);
      await refreshOrder(c, o.id);
      if (i.status === 'submitted_for_acceptance') await tell(c, await buyerAudience(c, o.buyer_id, ['acceptor']), { kind: 'svc_acceptance_needed', title: 'Work awaits your acceptance', body: `Order ${o.number} has work to review.`, data: { order_id: o.id, visit_id: v.id }, dedupe_key: `svc:submit:${v.id}:${row.row_version}` }, user.id);
      return row;
    });
  },
});
cap({
  name: 'reschedule_service_visit', method: 'POST', path: '/service-visits/:id/reschedule', tag: TAG,
  summary: 'Supplier scheduler: move an unstarted visit. Re-sending the same times changes nothing (no duplicate). Conflicts are refused.',
  input: z.object({ id, row_version: z.number().int(), starts_at: ts, ends_at: ts, reason: z.string().min(1).max(500), travel_buffer_minutes: z.number().int().min(0).max(240).default(0) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { v, o } = await visitFor(c, i.id);
      const { sup } = await orderSide(user, o, { buyer: false, supplier: ['owner', 'scheduler'] }, c);
      if (!sup) throw notFound('Visit');
      if (!['planned', 'confirmed', 'scheduled', 'paused'].includes(v.status)) throw conflict(`A ${v.status} visit cannot be rescheduled`);
      if (i.ends_at < i.starts_at) throw badRequest('ends_at is before starts_at');
      if (new Date(v.starts_at).getTime() === new Date(i.starts_at).getTime() && new Date(v.ends_at).getTime() === new Date(i.ends_at).getTime()) return v;
      if (v.row_version !== i.row_version) throw conflict('This visit changed since you opened it — reload and try again');
      const cf = await conflicts(c, { profileId: o.profile_id, resourceKey: v.resource_key, assignees: [...v.assignees, ...(v.supervisor_id ? [v.supervisor_id] : [])], startsAt: i.starts_at, endsAt: i.ends_at, bufferMin: i.travel_buffer_minutes, exceptVisit: v.id });
      if (cf.length) throw conflict('That time clashes with another booking', { conflicts: cf });
      const bl = await q1(c, 'SELECT 1 FROM svc_blackouts WHERE profile_id=$1 AND day=$2::date', [o.profile_id, i.starts_at]);
      if (bl) throw conflict('The supplier is unavailable that day');
      const row = await q1(c, 'UPDATE svc_visits SET starts_at=$2, ends_at=$3, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *', [v.id, i.starts_at, i.ends_at]);
      await log(c, 'visit', v.id, user.id, 'rescheduled', { from: v.starts_at, to: i.starts_at, reason: i.reason });
      await tell(c, await buyerAudience(c, o.buyer_id, ['requester', 'acceptor']), { kind: 'svc_visit_rescheduled', title: 'A visit was rescheduled', body: `Order ${o.number} has a new visit time.`, data: { order_id: o.id, visit_id: v.id }, dedupe_key: `svc:resched:${v.id}:${row.row_version}` }, user.id);
      return row;
    });
  },
});
cap({
  name: 'assign_service_crew', method: 'POST', path: '/service-visits/:id/crew', tag: TAG,
  summary: 'Supplier scheduler: set the supervisor and crew on an unstarted visit. Under-18 crew need the requirement to allow minors and an active guardian participation consent; conflicts are refused; the roster is never public.',
  input: z.object({ id, row_version: z.number().int(), supervisor_id: z.string().uuid().nullable().optional(), assignees: z.array(z.string().uuid()).max(100), travel_buffer_minutes: z.number().int().min(0).max(240).default(0), subcontractor: z.object({ name: z.string().min(1).max(160), approved_by_buyer: z.boolean().default(false) }).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { v, o } = await visitFor(c, i.id);
      const { sup } = await orderSide(user, o, { buyer: false, supplier: ['owner', 'scheduler'] }, c);
      if (!sup) throw notFound('Visit');
      if (['in_progress', 'submitted_for_acceptance', 'accepted', 'partially_accepted', 'cancelled'].includes(v.status)) throw conflict(`A ${v.status} visit’s crew cannot be changed`);
      if (v.row_version !== i.row_version) throw conflict('This visit changed since you opened it — reload and try again');
      const sup0 = i.supervisor_id === undefined ? v.supervisor_id : i.supervisor_id;
      const who = [...i.assignees, ...(sup0 ? [sup0] : [])];
      await checkCrew(c, o, who);
      const cf = await conflicts(c, { profileId: o.profile_id, resourceKey: null, assignees: who, startsAt: v.starts_at, endsAt: v.ends_at, bufferMin: i.travel_buffer_minutes, exceptVisit: v.id });
      if (cf.length) throw conflict('Someone is already booked at that time', { conflicts: cf });
      if (i.subcontractor && !i.subcontractor.approved_by_buyer && (await q1(c, "SELECT (terms->>'subcontractors_need_approval') AS n FROM svc_orders WHERE id=$1", [o.id]))?.n === 'true') throw conflict('The buyer must approve subcontractors on this order');
      return q1(c, 'UPDATE svc_visits SET supervisor_id=$2, assignees=$3, subcontractor=coalesce($4, subcontractor), row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *', [v.id, sup0 ?? null, i.assignees, i.subcontractor ? JSON.stringify(i.subcontractor) : null]);
    });
  },
});
cap({
  name: 'record_service_attendance', method: 'POST', path: '/service-visits/:id/attendance', tag: TAG, status: 201,
  summary: 'Supplier supervisor: record who attended (present, late, no-show, replaced) with hours — the timesheet. Replacement cover is recorded with who stood in.',
  input: z.object({ id, entries: z.array(z.object({ user_id: z.string().uuid().optional(), name: z.string().max(120).optional(), status: z.enum(['present', 'late', 'no_show', 'replaced']), checked_in_at: ts.optional(), checked_out_at: ts.optional(), hours: z.number().min(0).max(24).optional(), replaced_by: z.string().uuid().optional() })).min(1).max(100) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { v, o } = await visitFor(c, i.id);
      const { sup } = await orderSide(user, o, { buyer: false, supplier: ['owner', 'supervisor', 'scheduler'] }, c);
      if (!sup) throw notFound('Visit');
      if (!['in_progress', 'submitted_for_acceptance', 'scheduled', 'rework'].includes(v.status)) throw conflict(`A ${v.status} visit takes no attendance`);
      const out = [];
      for (const e of i.entries) {
        if (!e.user_id && !e.name) throw badRequest('Each entry needs a person');
        if (e.replaced_by) await checkCrew(c, o, [e.replaced_by]);
        out.push((await c.query('INSERT INTO svc_attendance(visit_id, user_id, name, status, checked_in_at, checked_out_at, hours, replaced_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [v.id, e.user_id ?? null, e.name ?? null, e.status, e.checked_in_at ?? null, e.checked_out_at ?? null, e.hours ?? null, e.replaced_by ?? null])).rows[0]);
        if (e.status === 'no_show') await c.query("INSERT INTO svc_incidents(order_id, visit_id, kind, detail, reported_by) VALUES ($1,$2,'no_show',$3,$4)", [o.id, v.id, e.name ?? 'A crew member did not attend', user.id]);
      }
      return out;
    });
  },
});
cap({
  name: 'report_service_incident', method: 'POST', path: '/service-orders/:id/incidents', tag: TAG, status: 201,
  summary: 'Either side records an incident, exception, no-show or replacement against an order or visit.',
  input: z.object({ id, visit_id: z.string().uuid().optional(), kind: z.enum(['incident', 'exception', 'no_show', 'replacement']), detail: z.string().min(1).max(2000) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const o = await loadOrder(c, i.id);
      await anySide(user, o, c);
      if (i.visit_id && !(await c.query('SELECT 1 FROM svc_visits WHERE id=$1 AND order_id=$2', [i.visit_id, o.id])).rowCount) throw notFound('Visit');
      return (await c.query('INSERT INTO svc_incidents(order_id, visit_id, kind, detail, reported_by) VALUES ($1,$2,$3,$4,$5) RETURNING *', [o.id, i.visit_id ?? null, i.kind, i.detail, user.id])).rows[0];
    });
  },
});
cap({
  name: 'list_service_incidents', method: 'GET', path: '/service-orders/:id/incidents', tag: TAG, summary: 'Incidents on an order (both sides).',
  input: z.object({ id, ...page }),
  async handler({ user }, i) { const o = await tx((c) => loadOrder(c, i.id)); await tx((c) => anySide(user, o, c)); return many('SELECT * FROM svc_incidents WHERE order_id=$1 ORDER BY created_at, id LIMIT $2 OFFSET $3', [o.id, i.limit, i.offset]); },
});

// ---------------------------------------------------------------- buyer acceptance
cap({
  name: 'accept_service_work', method: 'POST', path: '/service-orders/:id/acceptance', tag: TAG, status: 201,
  summary: 'Buyer service acceptor: accept (fully or partly) or reject work on an order line, optionally against a submitted visit. Accepted quantity can never exceed what was ordered; billing is capped at it. Rejection needs a reason and sets a rework deadline. The supplier’s own staff cannot accept — even if they also hold a buyer role. Idempotent per key.',
  input: z.object({ id, line_no: z.number().int().positive(), visit_id: z.string().uuid().optional(), decision: z.enum(['accepted', 'rejected']), quantity: z.number().min(0).max(1e9), reason: z.string().max(1000).optional(), rework_due: z.string().date().optional(), idempotency_key: z.string().min(1).max(64).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const o = await loadOrder(c, i.id, { lock: true });
      const { buy } = await orderSide(user, o, { buyer: ['acceptor'], supplier: false }, c);
      if (!buy) throw notFound('Order');
      if (await isOwnSupplier(c, user, o)) throw forbidden('The supplier cannot accept its own work');
      if (i.idempotency_key) { const d = await q1(c, 'SELECT * FROM svc_acceptances WHERE order_id=$1 AND idempotency_key=$2', [o.id, i.idempotency_key]); if (d) return { acceptance: d, replayed: true }; }
      if (!['confirmed', 'in_progress', 'completed', 'paused', 'terminated'].includes(o.status)) throw conflict(`Order is ${o.status}`);
      if (i.decision === 'rejected' && (!i.reason || !i.rework_due)) throw badRequest('A rejection needs a reason and a rework deadline');
      if (i.decision === 'accepted' && !(i.quantity > 0)) throw badRequest('Say how much you accept');
      const line = await q1(c, "SELECT * FROM svc_order_lines WHERE order_id=$1 AND line_no=$2 AND status='active' FOR UPDATE", [o.id, i.line_no]);
      if (!line) throw notFound('Order line');
      let visit = null;
      if (i.visit_id) {
        visit = await q1(c, 'SELECT * FROM svc_visits WHERE id=$1 AND order_id=$2 FOR UPDATE', [i.visit_id, o.id]);
        if (!visit || visit.line_id !== line.id) throw notFound('Visit');
        if (visit.status !== 'submitted_for_acceptance') throw conflict(`That visit is ${visit.status}, not awaiting acceptance`);
        if (i.decision === 'accepted' && i.quantity > Number(visit.actual_qty ?? visit.planned_qty) + 1e-9) throw conflict('You cannot accept more than the supplier reported');
      } else if (o.fulfilment !== 'cancelled' && (await q1(c, "SELECT 1 FROM svc_visits WHERE order_id=$1 AND line_id=$2 AND status='submitted_for_acceptance'", [o.id, line.id]))) {
        throw badRequest('This line has visits awaiting acceptance; accept them one by one');
      }
      if (i.decision === 'accepted') {
        const upd = await q1(c, 'UPDATE svc_order_lines SET qty_accepted = qty_accepted + $2 WHERE id=$1 AND qty_accepted + $2 <= qty_ordered RETURNING *', [line.id, i.quantity]);
        if (!upd) throw conflict(`Only ${Number(line.qty_ordered) - Number(line.qty_accepted)} is left to accept on this line`);
      }
      const row = await q1(c, 'INSERT INTO svc_acceptances(order_id, line_id, visit_id, decision, quantity, reason, rework_due, decided_by, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [o.id, line.id, visit?.id ?? null, i.decision, i.quantity, i.reason ?? null, i.rework_due ?? null, user.id, i.idempotency_key ?? null]);
      if (visit) {
        const full = i.decision === 'accepted' && i.quantity >= Number(visit.actual_qty ?? visit.planned_qty) - 1e-9;
        await c.query('UPDATE svc_visits SET status=$2, rework_due=$3, row_version=row_version+1 WHERE id=$1', [visit.id, i.decision === 'rejected' ? 'rework' : full ? 'accepted' : 'partially_accepted', i.rework_due ?? null]);
      }
      const order = await refreshOrder(c, o.id);
      await tell(c, await supplierAudience(c, o.profile_id), { kind: i.decision === 'accepted' ? 'svc_work_accepted' : 'svc_work_rejected', title: i.decision === 'accepted' ? 'Work accepted' : 'Work needs rework', body: `Order ${o.number}: open Gotmygame for details.`, data: { order_id: o.id }, dedupe_key: `svc:acc:${row.id}` }, user.id);
      await log(c, 'order', o.id, user.id, `work_${i.decision}`, { line_no: i.line_no, quantity: i.quantity, reason: i.reason ?? null });
      return { acceptance: row, order };
    });
  },
});
cap({
  name: 'list_service_acceptances', method: 'GET', path: '/service-orders/:id/acceptances', tag: TAG, summary: 'Acceptance decisions on an order (both sides).',
  input: z.object({ id, ...page }),
  async handler({ user }, i) { const o = await tx((c) => loadOrder(c, i.id)); await tx((c) => anySide(user, o, c)); return many('SELECT a.*, l.line_no FROM svc_acceptances a JOIN svc_order_lines l ON l.id=a.line_id WHERE a.order_id=$1 ORDER BY a.created_at, a.id LIMIT $2 OFFSET $3', [o.id, i.limit, i.offset]); },
});
