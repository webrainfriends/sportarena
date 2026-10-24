// Sponsor collaboration (#306): tasks, assignments, working notes, reminders and escalation on an agreement or a funding program. One definition
// -> REST + OpenAPI + MCP. Access is the canonical sponsor / recipient authority read live on every call (see sponsor-collaboration.js), so a person who
// has left loses read and write access at once, another side's internal items are invisible (404), and a notification deep link is checked again.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { tx, pool, many } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { toCsv } from '../csv.js';
import { SPONSOR_ACTIONS, notifySponsor } from '../sponsor-access.js';
import { notify } from '../notify.js';
import { ping } from './sponsorship-agreements.js';
import {
  TASK_KINDS, TASK_STATUS, TASK_COLS, scopeOf, scopeAccess, taskFor, assertCanWrite, assignable, presentTasks, sideRoster, staleTask, notifyTask, escalationRecipients, visibleSql, threadAccess, reminderChannels,
} from '../sponsor-collaboration.js';

const date = z.string().date();
const target = { sponsorship_id: id.optional().describe('the agreement this is about'), program_id: id.optional().describe('or the funding program (the brand\'s own workspace)') };
const version = z.coerce.number().int().min(1).describe('the row_version you were looking at; a task changed by someone else is refused (409)');
const where = (scope) => (scope.type === 'program' ? ['program_id', scope.id] : ['sponsorship_id', scope.id]);

/** The assignee must be somebody who is on the caller's side right now. */
async function checkAssignee(c, t, assigneeId) {
  if (!assigneeId) return;
  if (!(await sideRoster(c, t)).includes(assigneeId)) throw badRequest('That person is not part of your team for this agreement (anymore)');
}

cap({
  name: 'create_sponsorship_task', method: 'POST', path: '/sponsorship-tasks', tag: 'Sponsors', status: 201,
  summary: 'Create a task on an agreement or a funding program for your own side: a general task, a periodic review or an expiry / renewal watch, optionally assigned to somebody on your team and dated. `internal` tasks are visible to your side only; on an agreement a `shared` task is visible to the other side too (they cannot change it). The assignee and the brand managers are reminded before the due date, on it and when it is overdue, and a task that stays overdue is escalated to the managers. Notifications never contain the task text.',
  input: z.object({ ...target, title: z.string().trim().min(2).max(120), detail: z.string().trim().max(1000).optional(), kind: z.enum(TASK_KINDS).default('task'), visibility: z.enum(['internal', 'shared']).default('internal'),
    assignee_id: id.optional(), due_on: date.optional(), remind_days: z.coerce.number().int().min(0).max(30).default(3) }),
  async handler({ user }, i) {
    const scope = scopeOf(i);
    return tx(async (c) => {
      const access = await scopeAccess(c, user, scope, { lock: true });
      assertCanWrite(access, access.side);
      if (scope.type === 'program' && i.visibility === 'shared') throw badRequest('A program task is internal to the brand');
      const t0 = { [where(scope)[0]]: scope.id, side: access.side };
      await checkAssignee(c, t0, i.assignee_id);
      const [col, val] = where(scope);
      const row = (await c.query(
        `INSERT INTO sponsorship_tasks(${col}, side, visibility, kind, title, detail, assignee_id, due_on, remind_days, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [val, access.side, i.visibility, i.kind, i.title, i.detail || null, i.assignee_id ?? null, i.due_on ?? null, i.remind_days, user.id])).rows[0];
      const t = (await c.query(`SELECT ${TASK_COLS}, t.reminder_cycle FROM sponsorship_tasks t WHERE t.id=$1`, [row.id])).rows[0];
      await audit(c, user.id, 'create', 'sponsorship_tasks', t.id);
      if (t.assignee_id && t.assignee_id !== user.id) await notifyTask(c, [t.assignee_id], t, 'assigned', { cycle: `v${t.row_version}`, kind: 'sponsorship_task' });
      if (t.visibility === 'shared' && scope.type === 'agreement') await ping(c, access.side === 'sponsor' ? access.ctx.recipientId : 'sponsor', 'A shared task was added to a sponsorship agreement', access.ctx);
      return (await presentTasks(c, [t], access))[0];
    });
  },
});

cap({
  name: 'list_sponsorship_tasks', method: 'GET', path: '/sponsorship-tasks', tag: 'Sponsors',
  summary: 'Tasks of one agreement or program (sponsorship_id / program_id), or everything assigned to you across your agreements and programs (mine=true; only where you still have access). Your side\'s internal tasks plus shared ones; never the other side\'s internal tasks. Open tasks first by due date (undated last), then by id. Returns the people you can assign work to and whether you can change anything.',
  input: z.object({ ...target, mine: z.coerce.boolean().optional(), status: z.enum([...TASK_STATUS, 'all']).default('open'), ...page }),
  async handler({ user }, i) {
    const st = i.status === 'all' ? null : i.status;
    if (i.mine) {
      const rows = await many(`SELECT ${TASK_COLS}, t.reminder_cycle FROM sponsorship_tasks t WHERE t.assignee_id=$1 AND ($2::text IS NULL OR t.status=$2) ORDER BY t.due_on NULLS LAST, t.id LIMIT 500`, [user.id, st]);
      const seen = new Map(), keep = [];
      for (const r of rows) {
        const key = r.program_id ?? r.sponsorship_id;
        if (!seen.has(key)) seen.set(key, await scopeAccess(pool, user, r.program_id ? { type: 'program', id: key } : { type: 'agreement', id: key }).catch(() => null));
        const a = seen.get(key);
        if (a && a.side === r.side) keep.push([r, a]); // removed staff no longer see (or get reminded about) their old tasks
      }
      const slice = keep.slice(i.offset, i.offset + i.limit);
      const items = [];
      for (const [r, a] of slice) items.push(...await presentTasks(pool, [r], a));
      return { items, total: keep.length, limit: i.limit, offset: i.offset, reminders: await reminderChannels(pool) };
    }
    const scope = scopeOf(i);
    const access = await scopeAccess(pool, user, scope);
    const [col, val] = where(scope);
    const rows = await many(`SELECT ${TASK_COLS}, t.reminder_cycle FROM sponsorship_tasks t WHERE t.${col}=$1 AND ${visibleSql('t', access.side, 3)} AND ($2::text IS NULL OR t.status=$2) ORDER BY t.due_on NULLS LAST, t.id LIMIT $4 OFFSET $5`, [val, st, access.side ?? '', i.limit, i.offset]);
    const total = (await pool.query(`SELECT count(*)::int AS n FROM sponsorship_tasks t WHERE t.${col}=$1 AND ${visibleSql('t', access.side, 3)} AND ($2::text IS NULL OR t.status=$2)`, [val, st, access.side ?? ''])).rows[0].n;
    return { items: await presentTasks(pool, rows, access), total, limit: i.limit, offset: i.offset, side: access.side, can_write: access.write && !access.archived && !(access.deal && ['declined', 'withdrawn'].includes(access.deal.status)), assignable: await assignable(pool, access), reminders: await reminderChannels(pool) };
  },
});

cap({
  name: 'get_sponsorship_task', method: 'GET', path: '/sponsorship-tasks/:id', tag: 'Sponsors',
  summary: 'One task with its notes: the target of a notification link. Access is checked again here; someone who is no longer part of the team, or whose side the task is not shared with, gets 404.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { t, access } = await taskFor(pool, user, i.id);
    const notes = await many(
      `SELECT n.id, n.side, n.visibility, n.body, n.created_at, u.display_name AS author FROM sponsorship_notes n JOIN users u ON u.id=n.author_id WHERE n.task_id=$1 AND ${visibleSql('n', access.side, 2)} ORDER BY n.id LIMIT 100`, [t.id, access.side ?? '']);
    return { ...(await presentTasks(pool, [t], access))[0], notes_list: notes };
  },
});

cap({
  name: 'update_sponsorship_task', method: 'PATCH', path: '/sponsorship-tasks/:id', tag: 'Sponsors',
  summary: 'Change a task of your side: title, detail, due date, reminder days, assignee (null un-assigns), or its status (open -> done / cancelled, done -> open again; a cancelled task is final). Send the row_version you were looking at; if someone changed it meanwhile you get 409 stale_version. A new assignee is notified once; a changed assignee or due date restarts the reminders.',
  input: z.object({ id, expected_version: version, title: z.string().trim().min(2).max(120).optional(), detail: z.string().trim().max(1000).nullable().optional(), kind: z.enum(TASK_KINDS).optional(),
    assignee_id: id.nullable().optional(), due_on: date.nullable().optional(), remind_days: z.coerce.number().int().min(0).max(30).optional(), status: z.enum(TASK_STATUS).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { t, access } = await taskFor(c, user, i.id, { lock: true });
      assertCanWrite(access, t.side);
      staleTask(t, i.expected_version);
      if (t.status === 'cancelled') throw conflict('A cancelled task is final; create a new one', { code: 'invalid_transition' });
      const edits = ['title', 'detail', 'kind', 'assignee_id', 'due_on', 'remind_days'].filter((k) => i[k] !== undefined);
      if (t.status !== 'open' && edits.length) throw conflict(`A ${t.status} task cannot be edited; reopen it first`, { code: 'invalid_transition' });
      if (i.status && i.status !== t.status && !(t.status === 'open' && ['done', 'cancelled'].includes(i.status)) && !(t.status === 'done' && i.status === 'open')) throw conflict(`A ${t.status} task cannot become ${i.status}`, { code: 'invalid_transition' });
      if (i.assignee_id) await checkAssignee(c, t, i.assignee_id);
      const plan = i.assignee_id !== undefined && i.assignee_id !== t.assignee_id || i.due_on !== undefined && i.due_on !== t.due_on || (i.status === 'open' && t.status === 'done');
      const next = { ...t, ...Object.fromEntries(edits.map((k) => [k, i[k]])), ...(i.status ? { status: i.status } : {}) };
      await c.query(
        `UPDATE sponsorship_tasks SET title=$2, detail=$3, kind=$4, assignee_id=$5, due_on=$6, remind_days=$7, status=$8, row_version=row_version+1, updated_at=now(),
                reminder_cycle=reminder_cycle+$9, escalation_level=CASE WHEN $9=1 THEN 0 ELSE escalation_level END,
                completed_by=CASE WHEN $8='done' AND status<>'done' THEN $10::uuid WHEN $8='open' THEN NULL ELSE completed_by END,
                completed_at=CASE WHEN $8='done' AND status<>'done' THEN now() WHEN $8='open' THEN NULL ELSE completed_at END WHERE id=$1`,
        [t.id, next.title, next.detail ?? null, next.kind, next.assignee_id ?? null, next.due_on ?? null, next.remind_days, next.status, plan ? 1 : 0, user.id]);
      await audit(c, user.id, `update${i.status && i.status !== t.status ? `_${i.status}` : ''}`, 'sponsorship_tasks', t.id);
      const fresh = (await c.query(`SELECT ${TASK_COLS}, t.reminder_cycle FROM sponsorship_tasks t WHERE t.id=$1`, [t.id])).rows[0];
      if (i.assignee_id && i.assignee_id !== t.assignee_id && i.assignee_id !== user.id) await notifyTask(c, [i.assignee_id], fresh, 'assigned', { cycle: `v${fresh.row_version}`, kind: 'sponsorship_task' });
      return (await presentTasks(c, [fresh], access))[0];
    });
  },
});

cap({
  name: 'escalate_sponsorship_task', method: 'POST', path: '/sponsorship-tasks/:id/escalate', tag: 'Sponsors',
  summary: 'Hand an open task to the managers of your side now, with an optional reason (kept as an internal note on the task). The same escalation happens automatically when a task stays open two days past its due date. Send the row_version you were looking at, so a repeated tap or retry cannot escalate twice.',
  input: z.object({ id, expected_version: version, reason: z.string().trim().max(500).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const { t, access } = await taskFor(c, user, i.id, { lock: true });
      assertCanWrite(access, t.side);
      staleTask(t, i.expected_version);
      if (t.status !== 'open') throw conflict(`A ${t.status} task cannot be escalated`, { code: 'invalid_transition' });
      await c.query('UPDATE sponsorship_tasks SET escalated_at=now(), escalation_level=escalation_level+1, row_version=row_version+1, updated_at=now() WHERE id=$1', [t.id]);
      if (i.reason) await c.query("INSERT INTO sponsorship_notes(sponsorship_id, program_id, task_id, side, visibility, author_id, body) VALUES ($1,$2,$3,$4,'internal',$5,$6)", [t.sponsorship_id, t.program_id, t.id, t.side, user.id, `Escalated: ${i.reason}`]);
      await audit(c, user.id, 'escalate', 'sponsorship_tasks', t.id);
      await notifyTask(c, await escalationRecipients(c, t), t, 'escalated', { cycle: `m${t.row_version}`, except: user.id });
      const fresh = (await c.query(`SELECT ${TASK_COLS}, t.reminder_cycle FROM sponsorship_tasks t WHERE t.id=$1`, [t.id])).rows[0];
      return (await presentTasks(c, [fresh], access))[0];
    });
  },
});

const noteTarget = { ...target, application_id: id.optional().describe('one application of a program: the conversation between the brand and that applicant') };

/** Tell the other side of an application thread that something is waiting, never what it says. */
async function pingThread(c, acc, noteId) {
  const msg = (data) => ({ kind: 'sponsorship_update', title: 'New message about a sponsorship application', body: 'Open Gotmygame to see it.', data });
  if (acc.applicant) await notifySponsor(c, acc.sp, 'program', { ...msg({ program_id: acc.program.id, application_id: acc.application.id }), dedupe_key: `spapp:${noteId}` }, null);
  else await notify(c, acc.application.applicant_id, { ...msg({ application_id: acc.application.id }), dedupe_key: `spapp:${noteId}:a` });
}

cap({
  name: 'add_sponsorship_note', method: 'POST', path: '/sponsorship-notes', tag: 'Sponsors', status: 201,
  summary: 'Write a note on an agreement, a program, one of their tasks, or one application of a program. An `internal` note is a working note visible only to your own side: the other side and platform admins never see it. A `shared` note is a discussion message both sides see: on an agreement, between the sponsor and the recipient; on an application (application_id), between the brand (needs the program right) and that applicant only. The other side is told that something new is waiting, never what it says. An applicant can write once the application is submitted; a person under the age of independence cannot be put in a direct thread. Notes cannot be edited or removed.',
  input: z.object({ ...noteTarget, task_id: id.optional(), visibility: z.enum(['internal', 'shared']).default('internal'), body: z.string().trim().min(1).max(2000) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      if (i.application_id) {
        if (i.task_id || i.sponsorship_id) throw badRequest('An application thread has no task or agreement of its own');
        const acc = await threadAccess(c, user, i.application_id);
        if (i.program_id && i.program_id !== acc.program.id) throw badRequest('That application belongs to another program');
        if (acc.youth) throw forbidden('A guardian-led process applies; the brand cannot message a person under the age of independence directly');
        if (acc.archived) throw conflict('This program is archived; its conversations are read-only');
        if (!acc.write) throw forbidden(acc.applicant ? 'You can write once your application is submitted' : `Your role (${acc.staff}) cannot write notes for this brand`);
        const visibility = acc.applicant ? 'shared' : i.visibility;
        if (visibility === 'shared' && !acc.applicant && !acc.share) throw forbidden(`Your role (${acc.staff}) cannot speak to applicants for the brand`);
        const row = (await c.query('INSERT INTO sponsorship_notes(program_id, application_id, side, visibility, author_id, body) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, application_id, side, visibility, body, created_at', [acc.program.id, acc.application.id, acc.side, visibility, user.id, i.body])).rows[0];
        await audit(c, user.id, 'note', 'sponsorship_applications', acc.application.id);
        if (visibility === 'shared') await pingThread(c, acc, row.id);
        return { ...row, author: (await c.query('SELECT display_name FROM users WHERE id=$1', [user.id])).rows[0].display_name };
      }
      let task = null, scope;
      if (i.task_id) {
        const f = await taskFor(c, user, i.task_id);
        task = f.t; scope = task.program_id ? { type: 'program', id: task.program_id } : { type: 'agreement', id: task.sponsorship_id };
        if (i.sponsorship_id && i.sponsorship_id !== task.sponsorship_id || i.program_id && i.program_id !== task.program_id) throw badRequest('That task belongs to something else');
      } else scope = scopeOf(i);
      const access = await scopeAccess(c, user, scope);
      if (!access.side) throw forbidden('A platform admin cannot write notes');
      if (!access.write) throw forbidden(access.side === 'sponsor' ? `Your role (${access.staff}) cannot write notes for this brand` : 'Only a representative of the recipient can write notes');
      if (access.archived || (access.deal && ['declined', 'withdrawn'].includes(access.deal.status))) throw conflict('This is closed; notes can no longer be added');
      if (i.visibility === 'shared') {
        if (scope.type === 'program') throw badRequest('A program note is internal to the brand; to talk to an applicant, write on their application');
        if (task && task.visibility === 'internal') throw badRequest('A note on an internal task is internal');
        if (access.side === 'sponsor') access.ctx.need('revise', 'speak for the brand to the other side');
      }
      const [col, val] = where(scope);
      const row = (await c.query(`INSERT INTO sponsorship_notes(${col}, task_id, side, visibility, author_id, body) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, task_id, side, visibility, body, created_at`, [val, task?.id ?? null, access.side, i.visibility, user.id, i.body])).rows[0];
      await audit(c, user.id, 'note', scope.type === 'program' ? 'sponsorship_programs' : 'sponsorships', scope.id);
      if (i.visibility === 'shared') await ping(c, access.side === 'sponsor' ? access.ctx.recipientId : 'sponsor', 'New message on a sponsorship agreement', access.ctx);
      return { ...row, author: (await c.query('SELECT display_name FROM users WHERE id=$1', [user.id])).rows[0].display_name };
    });
  },
});

cap({
  name: 'list_sponsorship_notes', method: 'GET', path: '/sponsorship-notes', tag: 'Sponsors',
  summary: 'Notes of an agreement or program (or of one task, or one application thread): your side\'s internal notes plus the shared discussion, oldest first. The other side\'s internal notes are never returned; an applicant sees only their own application thread, and other applicants never do. The program list holds the brand\'s internal notes (application threads are read per application).',
  input: z.object({ ...noteTarget, task_id: id.optional(), ...page }),
  async handler({ user }, i) {
    if (i.application_id) {
      const acc = await threadAccess(pool, user, i.application_id);
      const items = await many(
        `SELECT n.id, n.application_id, n.side, n.visibility, n.body, n.created_at, u.display_name AS author FROM sponsorship_notes n JOIN users u ON u.id=n.author_id
          WHERE n.application_id=$1 AND ${visibleSql('n', acc.side, 2)} ORDER BY n.id LIMIT $3 OFFSET $4`, [acc.application.id, acc.side, i.limit, i.offset]);
      return { items, limit: i.limit, offset: i.offset, can_write: acc.write && !acc.youth, youth_blocked: !!acc.youth };
    }
    let scope, taskId = null;
    if (i.task_id) { const { t } = await taskFor(pool, user, i.task_id); taskId = t.id; scope = t.program_id ? { type: 'program', id: t.program_id } : { type: 'agreement', id: t.sponsorship_id }; }
    else scope = scopeOf(i);
    const access = await scopeAccess(pool, user, scope);
    const [col, val] = where(scope);
    const items = await many(
      `SELECT n.id, n.task_id, n.side, n.visibility, n.body, n.created_at, u.display_name AS author FROM sponsorship_notes n JOIN users u ON u.id=n.author_id
        WHERE n.${col}=$1 AND n.application_id IS NULL AND ($2::uuid IS NULL OR n.task_id=$2) AND ${visibleSql('n', access.side, 3)} ORDER BY n.id LIMIT $4 OFFSET $5`, [val, taskId, access.side ?? '', i.limit, i.offset]);
    return { items, limit: i.limit, offset: i.offset, can_write: access.write && !access.archived };
  },
});

cap({
  name: 'export_sponsorship_tasks', method: 'GET', path: '/sponsorship-task-export', tag: 'Sponsors',
  summary: 'CSV of the tasks of one agreement or program that your side may see (your internal tasks plus shared ones). Brand managers, finance and auditors may export for the brand, a recipient\'s representative for the recipient. Contains no money, contact or personal data beyond the assignee\'s display name, and the export is audit-logged.',
  input: z.object({ ...target }),
  async handler({ user }, i) {
    const scope = scopeOf(i);
    const access = await scopeAccess(pool, user, scope);
    if (!access.side || (access.side === 'sponsor' ? !SPONSOR_ACTIONS.export.includes(access.staff) : !access.write)) throw forbidden('Your role cannot export tasks');
    const [col, val] = where(scope);
    const rows = await many(
      `SELECT t.id, t.side, t.visibility, t.kind, t.title, t.status, a.display_name AS assignee, t.due_on::text AS due_on, t.escalation_level, t.created_at, t.completed_at
         FROM sponsorship_tasks t LEFT JOIN users a ON a.id=t.assignee_id WHERE t.${col}=$1 AND ${visibleSql('t', access.side, 2)} ORDER BY t.due_on NULLS LAST, t.id`, [val, access.side]);
    await audit(null, user.id, 'export', 'sponsorship_tasks', val);
    return { filename: `sponsorship-tasks-${val}.csv`, rows: rows.length, csv: toCsv(['id', 'side', 'visibility', 'kind', 'title', 'status', 'assignee', 'due_on', 'escalation_level', 'created_at', 'completed_at'], rows) };
  },
});
