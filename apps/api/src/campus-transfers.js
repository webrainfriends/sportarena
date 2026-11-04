// Campus transfer workflow engine (#781). A transfer of something already placed on a campus is a request that runs the academy's own configured
// process (approvals, finance clearance, athlete/guardian acknowledgement, handover checklist) and only then moves the effective-dated pointer.
// This module holds the rules shared by the capabilities and the worker sweep; it never copies or deletes the objects being moved.
import { z } from 'zod';
import { pool, tx } from './db.js';
import { badRequest, conflict } from './errors.js';
import { notify } from './notify.js';
import { audit } from './helpers.js';
import { unitMap, loadUnits, moveObject, event, ymd } from './campuses.js';

export const STEP_KINDS = ['approval', 'checklist', 'acknowledge'];
export const STEP_ROLES = ['source_director', 'destination_director', 'sports_lead', 'finance', 'admin', 'person'];
export const REASONS = ['relocation', 'pathway_progression', 'reorganisation', 'capacity', 'performance', 'family_request', 'data_correction', 'other'];
export const PERSON_TYPES = ['enrolment', 'staff'];   // only these have a person who can acknowledge

export const stepSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]{2,32}$/, 'lowercase letters, digits and _'),
  label: z.string().trim().min(3).max(80),
  kind: z.enum(STEP_KINDS),
  role: z.enum(STEP_ROLES),
  stage: z.number().int().min(1).max(6).default(1),
  required: z.boolean().default(true),
  sla_days: z.number().int().min(0).max(60).optional(),
  only_youth: z.boolean().default(false).describe('acknowledgement is only asked when the athlete is a minor (their guardian answers)'),
  items: z.array(z.string().trim().min(3).max(80)).max(12).default([]),
});
/** A definition must make sense: unique keys, acknowledgements by the person, checklists with items, no skipped stages. */
export function checkSteps(steps, objectType) {
  const keys = new Set();
  for (const s of steps) {
    if (keys.has(s.key)) throw badRequest(`Two steps use the key "${s.key}"`);
    keys.add(s.key);
    if (s.kind === 'acknowledge' && s.role !== 'person') throw badRequest('An acknowledgement is answered by the person (athlete, or their guardian)');
    if (s.kind !== 'acknowledge' && s.role === 'person') throw badRequest('Only an acknowledgement is answered by the person');
    if (s.kind === 'acknowledge' && !PERSON_TYPES.includes(objectType)) throw badRequest('Only athletes and staff can acknowledge a transfer');
    if (s.kind === 'checklist' && !s.items.length) throw badRequest(`The checklist "${s.label}" needs at least one item`);
    if (s.kind !== 'checklist' && s.items.length) throw badRequest(`Only a checklist has items ("${s.label}")`);
    if (s.only_youth && s.kind !== 'acknowledge') throw badRequest('Only an acknowledgement can be limited to minors');
  }
  const stages = [...new Set(steps.map((s) => s.stage))].sort((a, b) => a - b);
  if (stages.some((st, i) => st !== i + 1)) throw badRequest('Stages must be numbered 1, 2, 3 without gaps');
}

const S = (key, label, kind, role, stage, extra = {}) => ({ key, label, kind, role, stage, required: true, only_youth: false, items: [], ...extra });
const RELEASE = S('release', 'Release approval (current campus)', 'approval', 'source_director', 1, { sla_days: 3 });
const RECEIVE = S('receive', 'Acceptance (receiving campus)', 'approval', 'destination_director', 1, { sla_days: 3 });
/** Starting points an academy can adopt and edit. They are templates in the product, not data in any academy until it saves one. */
export const TEMPLATES = {
  enrolment: [RELEASE, RECEIVE,
    S('finance', 'Finance clearance (fees and balances)', 'approval', 'finance', 2, { sla_days: 5 }),
    S('athlete_ack', 'Athlete / guardian acknowledgement', 'acknowledge', 'person', 2, { sla_days: 7 }),
    S('handover', 'Handover checklist', 'checklist', 'destination_director', 3, { items: ['Training and development summary shared', 'Fee schedule confirmed with the family', 'Equipment and access returned', 'New coach briefed'] })],
  staff: [RELEASE, RECEIVE,
    S('contract_ack', 'Staff acknowledgement of the new posting', 'acknowledge', 'person', 2, { sla_days: 7 }),
    S('handover', 'Handover checklist', 'checklist', 'destination_director', 3, { items: ['Session cover arranged', 'Credentials verified for the new campus', 'Keys and access moved'] })],
  cohort: [RELEASE, RECEIVE, S('handover', 'Handover checklist', 'checklist', 'destination_director', 2, { items: ['Families told', 'Timetable and venue confirmed', 'Coaches assigned'] })],
  programme: [RELEASE, RECEIVE, S('handover', 'Handover checklist', 'checklist', 'destination_director', 2, { items: ['Families told', 'Timetable and venue confirmed', 'Fees reviewed'] })],
  team: [RELEASE, RECEIVE],
  venue: [RELEASE, RECEIVE],
  supplier: [RELEASE, RECEIVE],
  organisation: [RELEASE, RECEIVE],
};
/** What applies when an academy has not configured its own process yet: both campuses agree. */
export const DEFAULT_STEPS = [RELEASE, RECEIVE];

// ---------------------------------------------------------------------------- who may decide a step
const isAdminHere = (a) => a.all;
export function holds(a, step, t) {
  if (step.kind === 'acknowledge') return false;   // answered by the person, never on their behalf
  const r = step.role;
  if (r === 'admin') return isAdminHere(a);
  if (a.all) return false;   // owners/admins do not hold a branch role: they override, with a reason
  if (r === 'source_director') return a.can(t.from_unit_id, 'director');
  if (r === 'destination_director') return a.can(t.to_unit_id, 'director');
  if (r === 'sports_lead') return a.can(t.from_unit_id, 'sports_lead') || a.can(t.to_unit_id, 'sports_lead');
  if (r === 'finance') return a.can(t.from_unit_id, 'finance') || a.can(t.to_unit_id, 'finance') || a.member?.role === 'finance';
  return false;
}
/** Direct authority, or an owner/admin overriding (then a reason is required and the override is recorded). */
export const authority = (a, step, t) => (holds(a, step, t) ? 'role' : step.kind !== 'acknowledge' && isAdminHere(a) ? 'override' : null);

/** A step is open when everything required in the stages before it is complete. */
const COMPLETE = ['approved', 'done', 'skipped'];
export const isOpen = (steps, s) => s.status === 'pending' && steps.every((x) => !(x.required && x.stage < s.stage && !COMPLETE.includes(x.status)));
export const openIds = (steps) => new Set(steps.filter((s) => isOpen(steps, s)).map((s) => s.id));

/** People who can act on a step, by name (for the tracker and the notification). */
export async function approversOf(c, orgId, t, step) {
  const r = step.role;
  if (r === 'person') {
    const u = (await c.query('SELECT display_name FROM users WHERE id=$1', [step.target_user_id])).rows[0];
    return u ? [{ id: step.target_user_id, display_name: u.display_name }] : [];
  }
  if (r === 'admin') return (await c.query("SELECT u.id, u.display_name FROM organisation_members m JOIN users u ON u.id=m.user_id WHERE m.organisation_id=$1 AND m.status='active' AND m.role IN ('owner','admin') ORDER BY u.display_name", [orgId])).rows;
  const units = (await c.query('SELECT id, parent_id, kind FROM org_units WHERE organisation_id=$1', [orgId])).rows, map = new Map(units.map((u) => [u.id, u]));
  const up = (id) => { const out = []; for (let u = map.get(id), n = 0; u && n < 8; u = map.get(u.parent_id), n++) out.push(u.id); return out; };
  const [roleName, targets] = r === 'source_director' ? ['director', [t.from_unit_id]] : r === 'destination_director' ? ['director', [t.to_unit_id]] : r === 'sports_lead' ? ['sports_lead', [t.from_unit_id, t.to_unit_id]] : ['finance', [t.from_unit_id, t.to_unit_id]];
  const rows = (await c.query(
    `SELECT DISTINCT u.id, u.display_name, r.unit_id, r.inherit FROM org_unit_roles r JOIN users u ON u.id=r.user_id
      WHERE r.role=$1 AND r.ended_at IS NULL AND r.valid_from <= CURRENT_DATE AND (r.valid_to IS NULL OR r.valid_to >= CURRENT_DATE) AND r.unit_id = ANY($2)`, [roleName, targets.flatMap(up)])).rows;
  const people = rows.filter((x) => targets.some((tg) => x.unit_id === tg || (x.inherit && up(tg).includes(x.unit_id))));
  if (r === 'finance') people.push(...(await c.query("SELECT u.id, u.display_name FROM organisation_members m JOIN users u ON u.id=m.user_id WHERE m.organisation_id=$1 AND m.status='active' AND m.role='finance'", [orgId])).rows);
  return [...new Map(people.map((p) => [p.id, { id: p.id, display_name: p.display_name }])).values()];
}

const tell = (c, userIds, t, title, body) => Promise.all([...new Set(userIds)].map((u) => notify(c, u, { kind: 'campus_transfer', title, body, data: { organisation_id: t.organisation_id, transfer_id: t.id } }).catch(() => null)));

/** Tell the people whose step just opened. */
export async function notifyOpened(c, t, steps, before) {
  for (const s of steps) {
    if (!isOpen(steps, s) || before?.has(s.id)) continue;
    const who = await approversOf(c, t.organisation_id, t, s);
    await tell(c, who.map((w) => w.id), t, s.kind === 'acknowledge' ? 'Please acknowledge a transfer' : 'A transfer needs your decision', s.label);
  }
}

// ---------------------------------------------------------------------------- finishing and executing
/** Run the move itself: end each object's old link and start the new one on the effective date, as one change set. */
export async function executeTransfer(c, t, actor) {
  const map = unitMap(await loadUnits(t.organisation_id, c));
  const to = map.get(t.to_unit_id), today = new Date().toISOString().slice(0, 10), eff = t.allow_backdate ? ymd(t.effective_on) : (ymd(t.effective_on) > today ? ymd(t.effective_on) : today);
  if (to.status !== 'active') throw conflict(`${to.name} is ${to.status}: nothing can be placed on it`);
  const change = (await c.query("INSERT INTO org_unit_changes(organisation_id, kind, reason, effective_on, performed_by, summary) VALUES ($1,'transfer',$2,$3,$4,$5) RETURNING id", [t.organisation_id, t.reason_code, eff, actor ?? t.requested_by, JSON.stringify({ kind: 'transfer', transfer_id: t.id, to_unit_id: to.id, to_name: to.name, effective_on: eff, moved: t.object_ids.length, object_type: t.object_type })])).rows[0];
  for (const oid of t.object_ids) {
    const r = await moveObject(c, { unitsById: map, object_type: t.object_type, object_id: oid, to: t.to_unit_id, effective_on: eff, changeId: change.id, by: actor ?? t.requested_by });
    if (r.skipped) continue;
  }
  return change.id;
}

/** After any decision: close out the request when everything required is done, run it when its date has come. */
export async function advance(c, t, actor, before) {
  const steps = (await c.query('SELECT * FROM org_transfer_steps WHERE transfer_id=$1 ORDER BY seq', [t.id])).rows;
  const done = steps.filter((s) => s.required).every((s) => COMPLETE.includes(s.status));
  if (!done) { await notifyOpened(c, t, steps, before); return t.status; }
  await c.query("UPDATE org_transfer_steps SET status='skipped' WHERE transfer_id=$1 AND status='pending'", [t.id]);
  const today = new Date().toISOString().slice(0, 10);
  if (!t.allow_backdate && ymd(t.effective_on) > today) {
    await c.query("UPDATE org_transfers SET status='scheduled' WHERE id=$1", [t.id]);
    await event(c, t.organisation_id, t.to_unit_id, actor, 'transfer_scheduled', { transfer_id: t.id, effective_on: ymd(t.effective_on) });
    return 'scheduled';
  }
  return finish(c, t, actor);
}

async function finish(c, t, actor) {
  try {
    await c.query('SAVEPOINT exec');
    const changeId = await executeTransfer(c, t, actor);
    await c.query("UPDATE org_transfers SET status='completed', closed_at=now(), closed_by=$2, change_id=$3 WHERE id=$1", [t.id, actor ?? null, changeId]);
    for (const u of new Set([t.from_unit_id, t.to_unit_id])) await event(c, t.organisation_id, u, actor, 'transfer_completed', { transfer_id: t.id, count: t.object_ids.length, change_id: changeId }, changeId);
    await audit(c, actor ?? t.requested_by, 'complete_org_transfer', 'org_transfers', t.id);
    await tell(c, [t.requested_by], t, 'Transfer completed', 'The move has taken effect.');
    return 'completed';
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT exec');
    if (!(e.status === 409 || e.statusCode === 409 || e.code === 'conflict')) throw e;
    await c.query("UPDATE org_transfers SET status='failed', closed_at=now(), failure=$2 WHERE id=$1", [t.id, e.message]);
    await event(c, t.organisation_id, t.from_unit_id, actor, 'transfer_failed', { transfer_id: t.id, reason: e.message });
    await tell(c, [t.requested_by], t, 'Transfer could not be applied', e.message);
    return 'failed';
  }
}

/** Worker sweep: approved transfers whose effective date has arrived take effect. Idempotent: each is claimed under a row lock. */
export async function runDueTransfers() {
  const due = (await pool.query("SELECT id FROM org_transfers WHERE status='scheduled' AND effective_on <= CURRENT_DATE ORDER BY effective_on, id LIMIT 200")).rows;
  let n = 0;
  for (const d of due) await tx(async (c) => {
    const t = (await c.query("SELECT * FROM org_transfers WHERE id=$1 AND status='scheduled' AND effective_on <= CURRENT_DATE FOR UPDATE", [d.id])).rows[0];
    if (t && (await finish(c, t, null)) === 'completed') n++;
  });
  return n;
}
