// Sponsor collaboration (#306): tasks, assignments, working notes, due / review / expiry reminders and escalation on an agreement or a funding program.
// Everything reuses the canonical access rules: the live sponsor role (sponsor-access.js), the recipient / beneficiary representative (sponsor-beneficiaries.js)
// and the notification system (notify.js, with its per-user preferences and per-recipient dedupe). Authority is read live on EVERY call, so a person who has
// left the brand or the recipient organisation loses read and write access at once, and a deep link from a notification is just a read that is checked again.
//   internal  - visible to the owning side only (never the other side, never a platform admin)
//   shared    - visible to both sides; only the owning side edits it
import { pool, tx } from './db.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { notify } from './notify.js';
import { sponsorAccess, assertSponsorCan, sponsorRecipients } from './sponsor-access.js';
import { sponsorContactUser } from './sponsor-identity-access.js';
import { ORG_TARGETS, targetOrgId } from './sponsor-beneficiaries.js';
import { dealContext, targetOwner } from './sponsor-agreements.js';
import { localToday } from './sponsor-renewals.js';

export const TASK_KINDS = ['task', 'review', 'expiry'];
export const TASK_STATUS = ['open', 'done', 'cancelled'];
/** An open task this many whole days past its due date is escalated to the managers of its side. */
export const ESCALATE_AFTER_DAYS = 2;
export const CLOSED_DEAL = ['declined', 'withdrawn'];

export const TASK_COLS = `t.id, t.sponsorship_id, t.program_id, t.side, t.visibility, t.kind, t.title, t.detail, t.assignee_id, t.due_on::text AS due_on, t.remind_days, t.status, t.row_version,
  t.created_by, t.completed_at, t.escalated_at, t.escalation_level, t.created_at, t.updated_at`;

/** A task or note is addressed to exactly one agreement or one program. */
export function scopeOf(i) {
  const n = [i.sponsorship_id, i.program_id].filter(Boolean).length;
  if (n !== 1) throw badRequest('Say which agreement (sponsorship_id) or which program (program_id) this is about');
  return i.sponsorship_id ? { type: 'agreement', id: i.sponsorship_id } : { type: 'program', id: i.program_id };
}

/**
 * What the caller is on an agreement or program, read live: `{ side, write, ctx, sp, deal, program }`.
 * `side` is 'sponsor' | 'recipient' | null (a platform admin reads shared items only and writes nothing). Not part of it at all -> 404, so the
 * existence of an agreement or program is not revealed. `write` is whether they may add or change tasks and notes for their side.
 */
export async function scopeAccess(c, user, scope, { lock = false } = {}) {
  if (scope.type === 'program') {
    const p = (await c.query(`SELECT * FROM sponsorship_programs WHERE id=$1${lock ? ' FOR SHARE' : ''}`, [scope.id])).rows[0];
    const sp = p && (await c.query('SELECT id, name, owner_id, organisation_id, entity_id FROM sponsors WHERE id=$1', [p.sponsor_id])).rows[0];
    const access = sp && await sponsorAccess(user, sp, c);
    if (!access || access.departmentId) throw notFound('Sponsorship program'); // a program is the brand's own workspace; admins and other departments are not part of it
    const can = (a) => { try { assertSponsorCan(access, a, { departmentId: null }); return true; } catch { return false; } };
    return { scope, side: 'sponsor', write: can('collaborate'), canManage: can('manage'), program: p, deal: null, ctx: null, sp: { ...sp, owner_id: await sponsorContactUser(c, sp) }, staff: access.role, archived: p.status === 'archived' };
  }
  let ctx;
  try { ctx = await dealContext(c, scope.id, user); } catch (e) { if (e.status === 403 || e.status === 404) throw notFound('Sponsorship'); throw e; }
  if (ctx.role === 'admin') return { scope, side: null, write: false, canManage: false, deal: ctx.d, program: null, ctx, sp: ctx.sp, staff: null, archived: false };
  const side = ctx.role;
  const can = (a) => { try { ctx.need(a); return true; } catch { return false; } };
  const write = side === 'sponsor' ? can('collaborate') : !ctx.beneficiary || ctx.beneficiary.representative;
  return { scope, side, write, canManage: side === 'sponsor' ? can('manage') : write, deal: ctx.d, program: null, ctx, sp: ctx.sp, staff: ctx.staff, archived: false };
}

/** SQL fragment: the rows of a side-scoped table `alias` that the caller's side may see. */
export const visibleSql = (alias, side, n) => (side ? `(${alias}.visibility='shared' OR ${alias}.side=$${n}::text)` : `(${alias}.visibility='shared' AND $${n}::text IS NOT NULL)`);

/** Everyone who is, right now, on the given side of a task's agreement or program and may take work (live roster). */
export async function sideRoster(c, t, side = t.side) {
  if (t.program_id) {
    const p = (await c.query('SELECT sponsor_id FROM sponsorship_programs WHERE id=$1', [t.program_id])).rows[0];
    const sp = (await c.query('SELECT id, name, owner_id, organisation_id, entity_id FROM sponsors WHERE id=$1', [p.sponsor_id])).rows[0];
    return sponsorRecipients(c, { ...sp, owner_id: await sponsorContactUser(c, sp) }, 'collaborate', null);
  }
  const d = (await c.query('SELECT * FROM sponsorships WHERE id=$1', [t.sponsorship_id])).rows[0];
  if (side === 'sponsor') {
    const sp = (await c.query('SELECT id, name, owner_id, organisation_id, entity_id FROM sponsors WHERE id=$1', [d.sponsor_id])).rows[0];
    return sponsorRecipients(c, { ...sp, owner_id: await sponsorContactUser(c, sp) }, 'collaborate', d.department_id);
  }
  if (ORG_TARGETS.includes(d.target_type)) {
    const orgId = await targetOrgId(c, d.target_type, d.target_id).catch(() => null);
    if (!orgId) return [];
    return (await c.query("SELECT m.user_id FROM organisation_members m JOIN organisations o ON o.id=m.organisation_id WHERE m.organisation_id=$1 AND m.status='active' AND o.status='active' AND m.role IN ('owner','admin') ORDER BY m.user_id", [orgId])).rows.map((r) => r.user_id);
  }
  const owner = await targetOwner(c, d.target_type, d.target_id);
  return owner ? [owner] : [];
}

/** People the caller can assign work to (their own side only), with display names, for a picker. */
export async function assignable(c, access) {
  if (!access.side) return [];
  const ids = await sideRoster(c, access.program ? { program_id: access.program.id } : { sponsorship_id: access.deal.id }, access.side);
  if (!ids.length) return [];
  return (await c.query('SELECT id, display_name AS name FROM users WHERE id = ANY($1) ORDER BY display_name, id', [ids])).rows;
}

/** A task as the caller sees it. Names come from live user rows; whether the assignee is still on the team is checked, not assumed. */
export async function presentTasks(c, rows, access) {
  if (!rows.length) return [];
  const users = new Map((await c.query('SELECT id, display_name FROM users WHERE id = ANY($1)', [[...new Set(rows.flatMap((r) => [r.assignee_id, r.created_by]).filter(Boolean))]])).rows.map((u) => [u.id, u.display_name]));
  const notes = new Map((await c.query('SELECT task_id, count(*)::int AS n FROM sponsorship_notes WHERE task_id = ANY($1) AND (visibility=\'shared\' OR side=$2) GROUP BY task_id', [rows.map((r) => r.id), access.side ?? ''])).rows.map((n) => [n.task_id, n.n]));
  const roster = new Set(access.side ? await sideRoster(c, access.program ? { program_id: access.program.id } : { sponsorship_id: access.deal.id }, access.side) : []);
  const todayIso = (await c.query(`SELECT ${localToday('s')}::text AS d FROM (SELECT $1::text AS timezone) s`, [access.deal?.timezone ?? 'UTC'])).rows[0].d;
  return rows.map((r) => ({
    id: r.id, scope: r.program_id ? 'program' : 'agreement', sponsorship_id: r.sponsorship_id, program_id: r.program_id, side: r.side, visibility: r.visibility, kind: r.kind, title: r.title, detail: r.detail,
    assignee: r.assignee_id ? { id: r.assignee_id, name: users.get(r.assignee_id) ?? 'Former member', active: r.side === access.side ? roster.has(r.assignee_id) : null } : null,
    due_on: r.due_on, remind_days: r.remind_days, status: r.status, overdue: r.status === 'open' && !!r.due_on && r.due_on < todayIso,
    escalated_at: r.escalated_at, escalation_level: r.escalation_level, row_version: r.row_version, created_by: users.get(r.created_by) ?? null, created_at: r.created_at, completed_at: r.completed_at,
    notes: notes.get(r.id) ?? 0, mine: r.side === access.side,
    can_edit: access.write && r.side === access.side && !access.archived && !(r.sponsorship_id && CLOSED_DEAL.includes(access.deal.status)),
  }));
}

/**
 * Load one task for the caller: the task row (optionally locked) with their access. Not a participant, or someone else's internal task -> 404
 * (existence is not revealed). This is the single check behind reads, writes, exports and notification deep links.
 */
export async function taskFor(c, user, taskId, { lock = false } = {}) {
  const t = (await c.query(`SELECT ${TASK_COLS}, t.reminder_cycle FROM sponsorship_tasks t WHERE t.id=$1`, [taskId])).rows[0];
  if (!t) throw notFound('Task');
  const access = await scopeAccess(c, user, t.program_id ? { type: 'program', id: t.program_id } : { type: 'agreement', id: t.sponsorship_id }).catch((e) => { throw e.status === 404 ? notFound('Task') : e; });
  if (t.visibility === 'internal' && t.side !== access.side) throw notFound('Task');
  if (lock) return { t: (await c.query(`SELECT ${TASK_COLS}, t.reminder_cycle FROM sponsorship_tasks t WHERE t.id=$1 FOR UPDATE`, [taskId])).rows[0], access };
  return { t, access };
}

/** Throws unless the caller may change items of this side on this scope. */
export function assertCanWrite(access, side) {
  if (!access.side) throw forbidden('A platform admin can read shared tasks but cannot change them');
  if (access.side !== side) throw forbidden('Only the side that owns this can change it');
  if (!access.write) throw forbidden(access.side === 'sponsor' ? `Your role (${access.staff}) cannot manage tasks for this brand` : 'Only a representative of the recipient can manage tasks');
  if (access.archived || (access.deal && CLOSED_DEAL.includes(access.deal.status))) throw conflict('This is closed; tasks and notes can no longer be changed');
}

export const staleTask = (t, expected) => { if (t.row_version !== expected) throw conflict(`This task changed (now version ${t.row_version}); review it and try again`, { code: 'stale_version', row_version: t.row_version }); };

// ---- notifications: generic wording only (email and push leave the system in clear text), one per task / cycle / milestone / person

const TITLE = { upcoming: 'A sponsorship task is coming up', due: 'A sponsorship task is due today', overdue: 'A sponsorship task is overdue', escalated: 'A sponsorship task needs a manager', orphaned: 'A sponsorship task has no one to do it', assigned: 'A sponsorship task was assigned to you' };

/** One notification per person per (task, cycle, milestone): the dedupe key makes a retried job or a second worker send nothing new. */
export async function notifyTask(c, userIds, t, milestone, { cycle = t.reminder_cycle ?? 0, except = null, kind = milestone === 'escalated' || milestone === 'orphaned' ? 'sponsorship_task_escalation' : 'sponsorship_task' } = {}) {
  let sent = 0;
  for (const uid of new Set(userIds)) {
    if (!uid || uid === except) continue;
    const n = await notify(c, uid, {
      kind, title: TITLE[milestone], body: 'Open Gotmygame to see it.',
      data: { ...(t.sponsorship_id ? { sponsorship_id: t.sponsorship_id } : { program_id: t.program_id }), task_id: t.id },
      dedupe_key: `sptask:${t.id}:${cycle}:${milestone}:${uid}`,
    });
    if (n) sent++;
  }
  return sent;
}

/** Who answers for an escalated task: the managers of its side who are still there, plus its creator if still on the team. Falls back to the whole roster. */
export async function escalationRecipients(c, t) {
  const roster = await sideRoster(c, t);
  const sp = t.program_id
    ? (await c.query('SELECT s.* FROM sponsors s JOIN sponsorship_programs p ON p.sponsor_id=s.id WHERE p.id=$1', [t.program_id])).rows[0]
    : (await c.query('SELECT s.* FROM sponsors s JOIN sponsorships d ON d.sponsor_id=s.id WHERE d.id=$1', [t.sponsorship_id])).rows[0];
  const dept = t.sponsorship_id ? (await c.query('SELECT department_id FROM sponsorships WHERE id=$1', [t.sponsorship_id])).rows[0].department_id : null;
  const managers = t.side === 'sponsor' ? await sponsorRecipients(c, { ...sp, owner_id: await sponsorContactUser(c, sp) }, 'manage', dept) : roster;
  const ids = new Set(managers);
  if (t.created_by && roster.includes(t.created_by)) ids.add(t.created_by);
  return ids.size ? [...ids] : roster;
}

/**
 * Worker: due / review / expiry reminders and escalation. For every open task whose due date is within its reminder window (or past), in the agreement's
 * own timezone: remind the assignee once per cycle and milestone; a task with nobody (left or never assigned) goes to the managers instead; a task
 * still open ESCALATE_AFTER_DAYS past its date is escalated to the managers once. A catch-up after downtime sends the latest milestone only.
 * Rows are locked SKIP LOCKED and each notice is written in the same transaction as its notification, so a crash resends nothing twice and loses nothing.
 */
export async function sendTaskReminders({ limit = 200 } = {}) {
  const due = (await pool.query(
    `SELECT t.id FROM sponsorship_tasks t LEFT JOIN sponsorships s ON s.id=t.sponsorship_id LEFT JOIN sponsorship_programs p ON p.id=t.program_id
      WHERE t.status='open' AND t.due_on IS NOT NULL AND (s.id IS NULL OR s.status <> ALL($2)) AND (p.id IS NULL OR p.status <> 'archived')
        AND t.due_on - ${localToday('s')} <= t.remind_days
      ORDER BY t.due_on, t.id LIMIT $1`, [limit, CLOSED_DEAL])).rows;
  let n = 0;
  for (const x of due) {
    n += await tx(async (c) => {
      const t = (await c.query(
        `SELECT ${TASK_COLS}, t.reminder_cycle, t.due_on - ${localToday('s')} AS days FROM sponsorship_tasks t LEFT JOIN sponsorships s ON s.id=t.sponsorship_id
          WHERE t.id=$1 AND t.status='open' AND t.due_on IS NOT NULL FOR UPDATE OF t SKIP LOCKED`, [x.id])).rows[0];
      if (!t) return 0;
      const first = async (milestone) => (await c.query('INSERT INTO sponsorship_task_notices(task_id, cycle, milestone) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [t.id, t.reminder_cycle, milestone])).rowCount;
      const roster = await sideRoster(c, t);
      const hasAssignee = t.assignee_id && roster.includes(t.assignee_id);
      let sent = 0;
      if (hasAssignee) {
        const milestone = t.days < 0 ? 'overdue' : t.days === 0 ? 'due' : 'upcoming';
        if (await first(milestone)) sent += await notifyTask(c, [t.assignee_id], t, milestone);
      } else if (await first('orphaned')) sent += await notifyTask(c, await escalationRecipients(c, t), t, 'orphaned'); // nobody to remind: the managers are told once
      if (t.days <= -ESCALATE_AFTER_DAYS && await first('escalated')) {
        await c.query('UPDATE sponsorship_tasks SET escalated_at=now(), escalation_level=escalation_level+1, row_version=row_version+1 WHERE id=$1', [t.id]);
        sent += await notifyTask(c, await escalationRecipients(c, t), t, 'escalated');
      }
      return sent;
    });
  }
  return n;
}
