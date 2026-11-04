// Campus transfer workflow (#781). Each academy configures the process a transfer runs (approvals, finance clearance, athlete/guardian
// acknowledgement, handover checklist, notice period) per kind of object; a request then runs that process stage by stage and only moves
// the effective-dated pointer when everything required is done and the effective date has come. Owners/admins can override a step with a
// recorded reason; the person (or their guardian) acknowledges for themselves. Free-text notes about people are encrypted. Nothing is deleted.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { lockOrg } from '../org-access.js';
import { YOUTH_SQL, guardianLink, guardianCan } from '../youth.js';
import { OBJECT_TYPES, campusAccess, checkObjects, linkIndex, homeOf, carried, describe, event, ensureOrgWrite, unitMap, ymd } from '../campuses.js';
import { STEP_KINDS, STEP_ROLES, REASONS, TEMPLATES, DEFAULT_STEPS, stepSchema, checkSteps, holds, authority, isOpen, openIds, approversOf, notifyOpened, advance } from '../campus-transfers.js';

const TAG = 'Campuses';
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 864e5).toISOString().slice(0, 10);
const text = (n) => z.string().trim().max(n);
const TERMINAL = ['completed', 'rejected', 'cancelled', 'failed'];

const liveFlow = async (c, orgId, type) => (await c.query('SELECT * FROM org_transfer_flows WHERE organisation_id=$1 AND object_type=$2 AND archived_at IS NULL', [orgId, type])).rows[0] ?? null;
const flowView = (type, f) => ({ object_type: type, configured: !!f, name: f?.name ?? 'Both campuses agree (default)', version: f?.version ?? 0, min_notice_days: f?.min_notice_days ?? 0, allow_backdate: f?.allow_backdate ?? false, steps: f ? f.steps : DEFAULT_STEPS });

// ---------------------------------------------------------------------------- the academy's own process
cap({
  name: 'list_org_transfer_flows', method: 'GET', path: '/organisations/:id/transfer-flows', tag: TAG,
  summary: 'The transfer process the academy runs for each kind of object (athlete, coach/staff, cohort, programme, team, venue, supplier, child academy): its ordered stages (approval, checklist or acknowledgement steps, who decides, how many days they have), the notice period and whether back-dating is allowed. Kinds not configured yet use the default (both campuses agree). Also returns the starter templates an academy can adopt and edit.',
  input: z.object({ id }),
  handler: async ({ user }, i) => {
    const a = await campusAccess(user, i.id);
    const flows = [];
    for (const t of OBJECT_TYPES) flows.push(flowView(t, await liveFlow(pool, i.id, t)));
    return { flows, templates: TEMPLATES, step_kinds: STEP_KINDS, roles: STEP_ROLES, reasons: REASONS, can_configure: a.manage };
  },
});

cap({
  name: 'save_org_transfer_flow', method: 'POST', path: '/organisations/:id/transfer-flows', tag: TAG, status: 201,
  summary: 'Configure the transfer process for one kind of object (owner/admin). Steps are grouped in numbered stages: steps in one stage run in parallel, the next stage opens when every required step of the one before is complete. A step is an approval (a campus director, sports lead, finance or an admin decides), a checklist (the receiving side ticks off handover items) or an acknowledgement (the athlete, or their guardian if a minor, or the staff member). Each save is a new version; requests already running keep the version they started on. An empty process is allowed and means the move needs no sign-off.',
  input: z.object({ id, object_type: z.enum(OBJECT_TYPES), name: text(80).min(2), steps: z.array(stepSchema).max(12), min_notice_days: z.number().int().min(0).max(120).default(0), allow_backdate: z.boolean().default(false) }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await campusAccess(user, i.id, { c });
    await ensureOrgWrite(c, a);
    if (!a.manage) throw forbidden('Only owners and admins configure the transfer process');
    checkSteps(i.steps, i.object_type);
    await lockOrg(c, i.id);
    const prev = await liveFlow(c, i.id, i.object_type);
    if (prev) await c.query('UPDATE org_transfer_flows SET archived_at=now() WHERE id=$1', [prev.id]);
    const row = (await c.query('INSERT INTO org_transfer_flows(organisation_id, object_type, name, steps, min_notice_days, allow_backdate, version, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [i.id, i.object_type, i.name, JSON.stringify(i.steps), i.min_notice_days, i.allow_backdate, (prev?.version ?? 0) + 1, user.id])).rows[0];
    await audit(c, user.id, 'save_org_transfer_flow', 'org_transfer_flows', row.id);
    await event(c, i.id, null, user.id, 'transfer_flow_saved', { object_type: i.object_type, version: row.version, steps: i.steps.length });
    return flowView(i.object_type, row);
  }),
});

cap({
  name: 'list_org_transfer_destinations', method: 'GET', path: '/organisations/:id/transfer-destinations', tag: TAG,
  summary: 'Campuses and sport departments a transfer can go to, with their place in the hierarchy (names only). Pass from_unit_id to list only units of the same kind. Available to anyone who can start a transfer.',
  input: z.object({ id, from_unit_id: id.optional() }),
  handler: async ({ user }, i) => {
    const a = await campusAccess(user, i.id);
    const from = i.from_unit_id ? a.map.get(i.from_unit_id) : null;
    const path = (u) => { const out = []; for (let x = u, n = 0; x && n < 8; x = a.map.get(x.parent_id), n++) out.unshift(x.name); return out; };
    return a.units.filter((u) => u.kind !== 'region' && u.status === 'active' && (!from || (u.kind === from.kind && u.id !== from.id)))
      .map((u) => ({ id: u.id, name: u.name, kind: u.kind, sport: u.sport, path: path(u).join(' › ') })).sort((x, y) => x.path.localeCompare(y.path));
  },
});

// ---------------------------------------------------------------------------- request (with a full preview of the process that will run)
async function instantiate(c, flowSteps, type, ids, from) {
  const targets = type === 'enrolment' ? (await c.query('SELECT e.id, e.user_id, u.display_name FROM org_enrolments e JOIN users u ON u.id=e.user_id WHERE e.id = ANY($1)', [ids])).rows.map((r) => ({ object_id: r.id, user_id: r.user_id, name: r.display_name }))
    : type === 'staff' ? (await c.query('SELECT id AS user_id, id AS object_id, display_name AS name FROM users WHERE id = ANY($1)', [ids])).rows : [];
  const youth = new Set((await c.query(`SELECT u.id FROM users u WHERE u.id = ANY($1) AND ${YOUTH_SQL}`, [targets.map((x) => x.user_id)])).rows.map((r) => r.id));
  const out = [];
  for (const s of flowSteps) {
    const base = { key: s.key, stage: s.stage, kind: s.kind, role: s.role, required: s.required, items: s.items.map((label) => ({ label, done: false })), due_on: s.sla_days ? addDays(today(), s.sla_days) : null };
    if (s.kind !== 'acknowledge') { out.push({ ...base, label: s.label }); continue; }
    for (const t of targets) out.push({ ...base, label: targets.length > 1 ? `${s.label}: ${t.name}` : s.label, target_user_id: t.user_id, skip: s.only_youth && !youth.has(t.user_id), youth: youth.has(t.user_id) });
  }
  return out.map((s, n) => ({ ...s, seq: n + 1 }));
}

cap({
  name: 'request_org_transfer', method: 'POST', path: '/organisations/:id/transfers', tag: TAG, status: 201,
  summary: 'Start a transfer of things already placed on a campus (or department) to another one: athletes (enrolments), coaches/staff, cohorts, programmes, teams, venues, suppliers or child academies, all from the same current unit. It runs the academy\'s configured process for that kind of object: the people who must approve, tick off or acknowledge are notified as their stage opens, and the move takes effect on the effective date once everything required is done. Owners/admins and the source unit\'s director, sports lead or operations may start one. `dry_run` returns the process that would run (who decides each step, due dates, warnings, and what stays attached) without writing anything. Idempotent on idempotency_key.',
  input: z.object({ id, object_type: z.enum(OBJECT_TYPES), object_ids: z.array(id).min(1).max(50), to_unit_id: id, effective_on: z.string().date().optional(), reason_code: z.enum(REASONS), note: text(1000).optional(), dry_run: z.boolean().default(false), idempotency_key: z.string().min(8).max(80).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await campusAccess(user, i.id, { c });
    if (!i.dry_run) await ensureOrgWrite(c, a);
    await lockOrg(c, i.id);
    if (i.idempotency_key && !i.dry_run) {
      const prior = (await c.query('SELECT id FROM org_transfers WHERE organisation_id=$1 AND idempotency_key=$2', [i.id, i.idempotency_key])).rows[0];
      if (prior) return { transfer_id: prior.id, replayed: true };
    }
    const to = a.map.get(i.to_unit_id);
    if (!to || to.status !== 'active') throw badRequest('Choose an active campus or department as the destination');
    await checkObjects(c, i.id, i.object_type, i.object_ids);
    const idx = await linkIndex(c, i.id, today());
    const homes = [];
    for (const oid of i.object_ids) homes.push(await homeOf(c, a.map, idx, i.object_type, oid, to.kind));
    if (homes.some((h) => !h)) throw conflict('Something in the list is not placed on a campus yet. Place it first (owner/admin), then transfer it.');
    const from = homes[0];
    if (homes.some((h) => h.id !== from.id)) throw conflict('These are on different campuses. Start one transfer per source campus.');
    if (from.id === to.id) throw badRequest('It is already there');
    if (!a.all && !a.visible.has(from.id)) throw notFound('Unit');
    if (!a.all && !a.can(from.id, 'director', 'sports_lead', 'operations')) throw forbidden('Only an owner, an admin or the source unit\'s director, sports lead or operations can start a transfer');
    const flow = await liveFlow(c, i.id, i.object_type), fv = flowView(i.object_type, flow);
    const earliest = addDays(today(), fv.min_notice_days), eff = i.effective_on ?? earliest;
    if (eff < today() && !(fv.allow_backdate && a.all)) throw badRequest('The effective date cannot be in the past (back-dating is allowed only where the process permits it, and only for owners/admins)');
    if (eff >= today() && eff < earliest) throw badRequest(`This process needs ${fv.min_notice_days} days\' notice: the earliest effective date is ${earliest}`);
    const steps = await instantiate(c, fv.steps, i.object_type, i.object_ids, from);
    const names = await describe(c, i.object_type, i.object_ids, { people: true });
    const stub = { organisation_id: i.id, from_unit_id: from.id, to_unit_id: to.id };
    const view = [];
    for (const s of steps) view.push({ seq: s.seq, stage: s.stage, label: s.label, kind: s.kind, role: s.role, required: s.required, due_on: s.due_on, items: s.items.map((x) => x.label), skipped: !!s.skip, approvers: s.skip ? [] : (await approversOf(c, i.id, stub, s)).map((p) => p.display_name) });
    const warnings = view.filter((s) => !s.skipped && !s.approvers.length).map((s) => `Nobody holds the role for "${s.label}" yet: an owner or admin would have to override it`);
    const impact = await carried(c, [{ object_type: i.object_type, object_ids: i.object_ids }]);
    const preview = { from: { id: from.id, name: from.name, kind: from.kind }, to: { id: to.id, name: to.name, kind: to.kind }, objects: i.object_ids.map((oid) => ({ id: oid, label: names.get(oid)?.label ?? oid })), effective_on: eff, reason_code: i.reason_code,
      process: { configured: fv.configured, name: fv.name, version: fv.version, min_notice_days: fv.min_notice_days, steps: view }, warnings, stays_attached: impact, can_submit: true,
      preserved: 'Ids, history, sessions, charges, agreements and staff engagements are not touched: only the campus pointer changes, on the effective date, after the process completes.' };
    if (i.dry_run) return { dry_run: true, ...preview };
    const t = (await c.query(
      `INSERT INTO org_transfers(organisation_id, object_type, object_ids, from_unit_id, to_unit_id, effective_on, reason_code, note_enc, flow_id, flow_version, allow_backdate, requested_by, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [i.id, i.object_type, i.object_ids, from.id, to.id, eff, i.reason_code, i.note ? encrypt(i.note, 'org_transfers.note') : null, flow?.id ?? null, fv.version || null, eff < today(), user.id, i.idempotency_key ?? null])).rows[0];
    for (const s of steps) await c.query(
      "INSERT INTO org_transfer_steps(transfer_id, seq, stage, key, label, kind, role, required, target_user_id, due_on, items, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
      [t.id, s.seq, s.stage, s.key, s.label, s.kind, s.role, s.required, s.target_user_id ?? null, s.due_on, JSON.stringify(s.items), s.skip ? 'skipped' : 'pending']);
    await audit(c, user.id, 'request_org_transfer', 'org_transfers', t.id);
    for (const u of [from.id, to.id]) await event(c, i.id, u, user.id, 'transfer_requested', { transfer_id: t.id, count: i.object_ids.length, from: from.name, to: to.name, reason: i.reason_code });
    const state = await advance(c, t, user.id, new Set());
    if (state === 'in_progress') await notifyOpened(c, t, (await c.query('SELECT * FROM org_transfer_steps WHERE transfer_id=$1 ORDER BY seq', [t.id])).rows, new Set());
    return { transfer_id: t.id, status: (await c.query('SELECT status FROM org_transfers WHERE id=$1', [t.id])).rows[0].status, dry_run: false, ...preview };
  }),
});

// ---------------------------------------------------------------------------- reading
async function stepsWith(c, a, t) {
  const rows = (await c.query('SELECT s.*, u.display_name AS decided_by_name FROM org_transfer_steps s LEFT JOIN users u ON u.id=s.decided_by WHERE s.transfer_id=$1 ORDER BY s.seq', [t.id])).rows;
  const out = [];
  for (const s of rows) {
    const open = isOpen(rows, s), auth = a ? authority(a, s, t) : null;
    out.push({ id: s.id, seq: s.seq, stage: s.stage, key: s.key, label: s.label, kind: s.kind, role: s.role, required: s.required, status: s.status, due_on: ymd(s.due_on), overdue: s.status === 'pending' && s.due_on && ymd(s.due_on) < today(),
      items: s.items, open, can_act: open && !!auth, authority: open ? auth : null, decided_by_name: s.decided_by_name, decided_at: s.decided_at, override: s.override, note: s.note,
      approvers: s.status === 'pending' ? (await approversOf(c, t.organisation_id, t, s)).map((p) => p.display_name) : [] });
  }
  return out;
}
const canSee = (a, t, user, steps) => a.all || a.visible.has(t.from_unit_id) || a.visible.has(t.to_unit_id) || t.requested_by === user.id || steps.some((s) => s.can_act);

cap({
  name: 'list_org_transfers', method: 'GET', path: '/organisations/:id/transfers', tag: TAG,
  summary: 'Transfer requests with their progress. `view` = awaiting_me (a step open to you), active (in progress or scheduled), or closed (completed, rejected, cancelled, failed). Owners/admins see all; others see transfers touching their branches or that they started.',
  input: z.object({ id, view: z.enum(['awaiting_me', 'active', 'closed']).default('active'), unit_id: id.optional(), ...page }),
  handler: async ({ user }, i) => {
    const a = await campusAccess(user, i.id);
    const rows = (await pool.query(
      `SELECT t.*, fu.name AS from_name, tu.name AS to_name, ru.display_name AS requested_by_name FROM org_transfers t JOIN org_units fu ON fu.id=t.from_unit_id JOIN org_units tu ON tu.id=t.to_unit_id JOIN users ru ON ru.id=t.requested_by
        WHERE t.organisation_id=$1 AND (($2::text = 'closed' AND t.status = ANY($3)) OR ($2::text <> 'closed' AND NOT t.status = ANY($3))) AND ($4::uuid IS NULL OR t.from_unit_id=$4 OR t.to_unit_id=$4) ORDER BY t.requested_at DESC LIMIT 400`,
      [i.id, i.view, TERMINAL, i.unit_id ?? null])).rows;
    const out = [];
    for (const t of rows) {
      const steps = await stepsWith(pool, a, t);
      if (!canSee(a, t, user, steps)) continue;
      const mine = steps.some((s) => s.can_act && s.authority === 'role');
      if (i.view === 'awaiting_me' && !steps.some((s) => s.can_act)) continue;
      const req = steps.filter((s) => s.required && s.status !== 'skipped');
      const names = await describe(pool, t.object_type, t.object_ids.slice(0, 3), { people: a.all || a.can(t.from_unit_id, 'director', 'sports_lead', 'coach', 'operations') || a.can(t.to_unit_id, 'director', 'sports_lead', 'coach', 'operations') });
      out.push({ id: t.id, object_type: t.object_type, count: t.object_ids.length, labels: t.object_ids.slice(0, 3).map((o) => names.get(o)?.label ?? ''), from: { id: t.from_unit_id, name: t.from_name }, to: { id: t.to_unit_id, name: t.to_name }, effective_on: ymd(t.effective_on), reason_code: t.reason_code, status: t.status,
        requested_by_name: t.requested_by_name, requested_at: t.requested_at, progress: { done: req.filter((s) => COMPLETE.includes(s.status)).length, total: req.length }, awaiting: steps.filter((s) => s.open).map((s) => s.label), overdue: steps.some((s) => s.overdue), mine_to_act: mine, failure: t.failure });
    }
    return out.slice(i.offset, i.offset + i.limit);
  },
});
const COMPLETE = ['approved', 'done', 'skipped'];

cap({
  name: 'get_org_transfer', method: 'GET', path: '/organisations/:id/transfers/:transfer_id', tag: TAG,
  summary: 'One transfer: the objects, from and to, effective date, reason and note (the note is encrypted and reading it is audit-logged), every step with who must act, who decided and when, due dates and overdue flags, the checklist items, which step you can act on, and the timeline.',
  input: z.object({ id, transfer_id: id }),
  handler: async ({ user }, i) => {
    const a = await campusAccess(user, i.id);
    const t = (await pool.query('SELECT t.*, fu.name AS from_name, tu.name AS to_name, ru.display_name AS requested_by_name FROM org_transfers t JOIN org_units fu ON fu.id=t.from_unit_id JOIN org_units tu ON tu.id=t.to_unit_id JOIN users ru ON ru.id=t.requested_by WHERE t.id=$1 AND t.organisation_id=$2', [i.transfer_id, i.id])).rows[0];
    if (!t) throw notFound('Transfer');
    const steps = await stepsWith(pool, a, t);
    if (!canSee(a, t, user, steps)) throw notFound('Transfer');
    const people = a.all || a.can(t.from_unit_id, 'director', 'sports_lead', 'coach', 'operations') || a.can(t.to_unit_id, 'director', 'sports_lead', 'coach', 'operations');
    const names = await describe(pool, t.object_type, t.object_ids, { people });
    let note = null;
    if (t.note_enc) { note = decrypt(t.note_enc, 'org_transfers.note'); await audit(pool, user.id, 'read_org_transfer_note', 'org_transfers', t.id); }
    const timeline = await many("SELECT ev.id, ev.action, ev.detail, ev.at, u.display_name AS actor_name FROM org_unit_events ev LEFT JOIN users u ON u.id=ev.actor_id WHERE ev.organisation_id=$1 AND ev.detail->>'transfer_id' = $2 ORDER BY ev.at, ev.id", [i.id, t.id]);
    const seen = new Set(), uniq = timeline.filter((e) => { const k = `${e.action}:${e.at.getTime?.() ?? e.at}`; return seen.has(k) ? false : seen.add(k); });
    return { id: t.id, object_type: t.object_type, objects: t.object_ids.map((o) => ({ id: o, label: names.get(o)?.label ?? o, sub: names.get(o)?.sub ?? null })), from: { id: t.from_unit_id, name: t.from_name }, to: { id: t.to_unit_id, name: t.to_name },
      effective_on: ymd(t.effective_on), reason_code: t.reason_code, note, status: t.status, requested_by_name: t.requested_by_name, requested_at: t.requested_at, closed_at: t.closed_at, failure: t.failure, change_id: t.change_id,
      flow_version: t.flow_version, steps, timeline: uniq, can_cancel: !TERMINAL.includes(t.status) && (a.all || t.requested_by === user.id) };
  },
});

// ---------------------------------------------------------------------------- deciding
cap({
  name: 'decide_org_transfer_step', method: 'POST', path: '/organisations/:id/transfers/:transfer_id/steps/:step_id', tag: TAG,
  summary: 'Act on an open step. Approval: approve or reject (a rejection needs a note and ends the transfer). Checklist: tick items (decision "save"), then "complete" once every item is ticked. Only the role the step names can decide; an owner/admin may override with a reason, and the override is recorded. Steps in later stages stay closed until the stage before is complete. When the last required step is done the move takes effect (or is scheduled for its effective date). Acknowledgements are answered by the athlete or guardian through respond_to_transfer_acknowledgement.',
  input: z.object({ id, transfer_id: id, step_id: id, decision: z.enum(['approve', 'reject', 'save', 'complete']), items_done: z.array(z.number().int().min(0).max(11)).max(12).optional(), note: text(500).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await campusAccess(user, i.id, { c });
    await ensureOrgWrite(c, a);
    const t = (await c.query('SELECT * FROM org_transfers WHERE id=$1 AND organisation_id=$2 FOR UPDATE', [i.transfer_id, i.id])).rows[0];
    if (!t) throw notFound('Transfer');
    if (t.status !== 'in_progress') throw conflict(`This transfer is ${t.status}`);
    const steps = (await c.query('SELECT * FROM org_transfer_steps WHERE transfer_id=$1 ORDER BY seq', [t.id])).rows;
    const s = steps.find((x) => x.id === i.step_id);
    if (!s) throw notFound('Step');
    const auth = authority(a, s, t);
    if (!auth) { if (!(a.all || a.visible.has(t.from_unit_id) || a.visible.has(t.to_unit_id) || t.requested_by === user.id)) throw notFound('Transfer'); throw forbidden(s.kind === 'acknowledge' ? 'This is answered by the athlete (or their guardian) themselves' : 'This step is for someone else\'s role'); }
    if (!isOpen(steps, s)) throw conflict(s.status === 'pending' ? 'This step opens when the stage before it is complete' : `This step is already ${s.status}`);
    if (auth === 'override' && (i.note ?? '').trim().length < 5) throw badRequest('Deciding on behalf of the role needs a reason (at least 5 characters)');
    if (s.kind === 'approval' && !['approve', 'reject'].includes(i.decision)) throw badRequest('An approval is approved or rejected');
    if (s.kind === 'checklist' && !['save', 'complete', 'reject'].includes(i.decision)) throw badRequest('A checklist is saved or completed');
    if (i.decision === 'reject' && (i.note ?? '').trim().length < 5) throw badRequest('Say why (at least 5 characters)');
    const before = openIds(steps);
    let items = s.items;
    if (s.kind === 'checklist' && i.items_done) items = s.items.map((it, n) => ({ ...it, done: i.items_done.includes(n), done_by: i.items_done.includes(n) ? (it.done ? it.done_by : user.id) : null, done_at: i.items_done.includes(n) ? (it.done ? it.done_at : new Date().toISOString()) : null }));
    if (i.decision === 'complete' && items.some((x) => !x.done)) throw conflict(`${items.filter((x) => !x.done).length} checklist item(s) are not ticked yet`);
    const status = i.decision === 'approve' ? 'approved' : i.decision === 'complete' ? 'done' : i.decision === 'reject' ? 'rejected' : 'pending';
    await c.query('UPDATE org_transfer_steps SET items=$2, status=$3, note=coalesce($4, note), decided_by=CASE WHEN $3=\'pending\' THEN decided_by ELSE $5 END, decided_at=CASE WHEN $3=\'pending\' THEN decided_at ELSE now() END, override=$6 WHERE id=$1',
      [s.id, JSON.stringify(items), status, i.note ?? null, user.id, auth === 'override']);
    await audit(c, user.id, `org_transfer_step_${i.decision}`, 'org_transfers', t.id);
    for (const u of new Set([t.from_unit_id, t.to_unit_id])) await event(c, i.id, u, user.id, `transfer_step_${i.decision}`, { transfer_id: t.id, step: s.label, override: auth === 'override', note: i.note ?? null });
    if (i.decision === 'reject') {
      await c.query("UPDATE org_transfer_steps SET status='skipped' WHERE transfer_id=$1 AND status='pending'", [t.id]);
      await c.query("UPDATE org_transfers SET status='rejected', closed_at=now(), closed_by=$2 WHERE id=$1", [t.id, user.id]);
      await event(c, i.id, t.from_unit_id, user.id, 'transfer_rejected', { transfer_id: t.id, step: s.label });
      return { status: 'rejected' };
    }
    return { status: i.decision === 'save' ? 'in_progress' : await advance(c, t, user.id, before) };
  }),
});

cap({
  name: 'cancel_org_transfer', method: 'POST', path: '/organisations/:id/transfers/:transfer_id/cancel', tag: TAG,
  summary: 'Withdraw a transfer before it takes effect (the person who started it, or an owner/admin). Open steps are closed, the objects stay where they are, and the cancellation is recorded.',
  input: z.object({ id, transfer_id: id, reason: text(300).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await campusAccess(user, i.id, { c });
    await ensureOrgWrite(c, a);
    const t = (await c.query('SELECT * FROM org_transfers WHERE id=$1 AND organisation_id=$2 FOR UPDATE', [i.transfer_id, i.id])).rows[0];
    if (!t || !(a.all || t.requested_by === user.id)) throw notFound('Transfer');
    if (TERMINAL.includes(t.status)) throw conflict(`This transfer is already ${t.status}`);
    await c.query("UPDATE org_transfer_steps SET status='skipped' WHERE transfer_id=$1 AND status='pending'", [t.id]);
    await c.query("UPDATE org_transfers SET status='cancelled', closed_at=now(), closed_by=$2 WHERE id=$1", [t.id, user.id]);
    await audit(c, user.id, 'cancel_org_transfer', 'org_transfers', t.id);
    for (const u of new Set([t.from_unit_id, t.to_unit_id])) await event(c, i.id, u, user.id, 'transfer_cancelled', { transfer_id: t.id, reason: i.reason ?? null });
    return { status: 'cancelled' };
  }),
});

// ---------------------------------------------------------------------------- the athlete / guardian / staff member answers for themselves
async function myAckRows(c, userId) {
  const rows = (await c.query(
    `SELECT s.id AS step_id, s.transfer_id, s.label, s.due_on, s.target_user_id, t.organisation_id, t.effective_on, t.object_type, o.name AS organisation_name, fu.name AS from_name, tu.name AS to_name, pu.display_name AS person_name, ${YOUTH_SQL.replaceAll('u.', 'pu.')} AS youth
       FROM org_transfer_steps s JOIN org_transfers t ON t.id=s.transfer_id JOIN organisations o ON o.id=t.organisation_id JOIN org_units fu ON fu.id=t.from_unit_id JOIN org_units tu ON tu.id=t.to_unit_id JOIN users pu ON pu.id=s.target_user_id
      WHERE s.kind='acknowledge' AND s.status='pending' AND t.status='in_progress'`)).rows;
  const out = [];
  for (const r of rows) {
    const all = (await c.query('SELECT * FROM org_transfer_steps WHERE transfer_id=$1', [r.transfer_id])).rows;
    if (!isOpen(all, all.find((x) => x.id === r.step_id))) continue;
    if (r.youth) { const link = await guardianLink(userId, r.target_user_id, c); if (!link || !(await guardianCan(link, 'consent', r.organisation_id, c))) continue; out.push({ ...r, answering_as: 'guardian', link }); }
    else if (r.target_user_id === userId) out.push({ ...r, answering_as: 'self' });
  }
  return out;
}

cap({
  name: 'list_my_transfer_acknowledgements', method: 'GET', path: '/me/transfer-acknowledgements', tag: TAG,
  summary: 'Transfers waiting for you to acknowledge: your own (athlete or staff member), or your child\'s if you are their verified guardian with consent authority. Only the open step is shown, with the campuses and effective date.',
  input: z.object({}),
  handler: async ({ user }) => (await myAckRows(pool, user.id)).map(({ link, youth, ...r }) => ({ ...r, due_on: ymd(r.due_on), effective_on: ymd(r.effective_on) })),
});

cap({
  name: 'respond_to_transfer_acknowledgement', method: 'POST', path: '/me/transfer-acknowledgements/:step_id', tag: TAG,
  summary: 'Acknowledge or decline a transfer for yourself, or for your child as their guardian. A minor cannot answer for themselves. Declining ends the transfer and tells the academy. The answer, who gave it and when are recorded.',
  input: z.object({ step_id: id, decision: z.enum(['acknowledge', 'decline']), note: text(300).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const mine = (await myAckRows(c, user.id)).find((r) => r.step_id === i.step_id);
    if (!mine) throw notFound('Acknowledgement');
    const t = (await c.query("SELECT * FROM org_transfers WHERE id=$1 AND status='in_progress' FOR UPDATE", [mine.transfer_id])).rows[0];
    if (!t) throw conflict('This transfer is no longer open');
    const steps = (await c.query('SELECT * FROM org_transfer_steps WHERE transfer_id=$1 ORDER BY seq', [t.id])).rows, before = openIds(steps);
    const done = i.decision === 'acknowledge';
    await c.query("UPDATE org_transfer_steps SET status=$2, decided_by=$3, decided_at=now(), note=$4 WHERE id=$1 AND status='pending'", [i.step_id, done ? 'done' : 'declined', user.id, i.note ?? null]);
    await audit(c, user.id, done ? 'acknowledge_org_transfer' : 'decline_org_transfer', 'org_transfers', t.id);
    for (const u of new Set([t.from_unit_id, t.to_unit_id])) await event(c, t.organisation_id, u, user.id, done ? 'transfer_acknowledged' : 'transfer_declined', { transfer_id: t.id, as: mine.answering_as });
    if (!done) {
      await c.query("UPDATE org_transfer_steps SET status='skipped' WHERE transfer_id=$1 AND status='pending'", [t.id]);
      await c.query("UPDATE org_transfers SET status='rejected', closed_at=now(), closed_by=$2 WHERE id=$1", [t.id, user.id]);
      return { status: 'rejected' };
    }
    return { status: await advance(c, t, user.id, before) };
  }),
});
