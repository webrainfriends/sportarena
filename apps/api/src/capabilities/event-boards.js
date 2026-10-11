import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { mustFind, PUBLIC_USER } from '../helpers.js';
import { notify } from '../notify.js';
import { departmentScope } from './event-departments.js';

const TAG = 'Event boards';
const key = z.string().regex(/^[a-z][a-z0-9_]{0,23}$/);
const column = z.object({ key, label: z.string().min(1).max(30) });
const dt = z.string().datetime({ offset: true });
const date = z.string().date();
const priority = z.enum(['low', 'normal', 'high', 'urgent']);
const checklist = z.array(z.object({ text: z.string().min(1).max(200), done: z.boolean().default(false) })).max(50);

const DEFAULT_COLUMNS = [{ key: 'backlog', label: 'Backlog' }, { key: 'doing', label: 'Doing' }, { key: 'blocked', label: 'Blocked' }, { key: 'review', label: 'Review' }, { key: 'done', label: 'Done' }];
const q = (c) => c ?? pool;

async function loadPlan(planId, c) {
  const p = (await q(c).query('SELECT * FROM event_plans WHERE id=$1', [planId])).rows[0];
  if (!p) throw notFound('Plan');
  return p;
}
/** What the caller may do on a department's board. */
async function access(user, departmentId, c) {
  const d = (await q(c).query('SELECT * FROM event_departments WHERE id=$1', [departmentId])).rows[0];
  if (!d) throw notFound('Department');
  const ev = await mustFind('events', d.event_id, '*', c);
  const s = await departmentScope(user, ev, c);
  return { d, ev, manage: s.organiser || s.led.has(d.id), work: s.organiser || s.led.has(d.id) || s.member.has(d.id) };
}
const needManage = (a) => { if (!a.manage) throw forbidden('Only the organiser or the department lead can do that'); };
const needWork = (a) => { if (!a.work) throw forbidden('Only the department team can do that'); };
const live = (ev) => { if (['completed', 'cancelled'].includes(ev.status)) throw conflict(`Event is ${ev.status}`); };
const doneKey = (plan) => plan.columns[plan.columns.length - 1].key;
const hasColumn = (plan, k) => plan.columns.some((x) => x.key === k);

async function checkAssignees(c, departmentId, ids) {
  if (!ids?.length) return;
  const ok = (await c.query("SELECT user_id FROM event_department_members WHERE department_id=$1 AND status='active' AND user_id = ANY($2::uuid[])", [departmentId, ids])).rows.map((r) => r.user_id);
  const bad = ids.filter((x) => !ok.includes(x));
  if (bad.length) throw badRequest('Assignees must be active members of the department', { not_members: bad });
}
const log = (c, cardId, actor, action, from = null, to = null, note = null) =>
  c.query('INSERT INTO event_card_history(card_id, actor_id, action, from_column, to_column, note) VALUES ($1,$2,$3,$4,$5,$6)', [cardId, actor, action, from, to, note]);

/** Re-number a column so positions are 0..n-1, with `cardId` placed at `index` (or last). */
async function place(c, planId, columnKey, cardId, index) {
  const others = (await c.query("SELECT id FROM event_cards WHERE plan_id=$1 AND column_key=$2 AND status='active' AND id<>$3 ORDER BY position, created_at", [planId, columnKey, cardId])).rows.map((r) => r.id);
  const at = index === undefined || index > others.length ? others.length : index;
  others.splice(at, 0, cardId);
  for (const [n, cid] of others.entries()) await c.query('UPDATE event_cards SET position=$2 WHERE id=$1 AND position<>$2', [cid, n]);
}

// ------------------------------------------------------------------ plans
cap({
  name: 'create_event_plan', method: 'POST', path: '/departments/:id/plans', tag: TAG, status: 201,
  summary: 'Start a plan (a kanban board) for a department, with its own dates and goal. Columns default to Backlog / Doing / Blocked / Review / Done; the last column means done.',
  input: z.object({ id, title: z.string().min(2).max(120), goal: z.string().max(1000).optional(), starts_on: date.optional(), ends_on: date.optional(), columns: z.array(column).min(2).max(8).optional() }),
  async handler({ user }, i) {
    if (i.starts_on && i.ends_on && i.ends_on < i.starts_on) throw badRequest('ends_on is before starts_on');
    if (i.columns && new Set(i.columns.map((x) => x.key)).size !== i.columns.length) throw badRequest('Column keys must be unique');
    return tx(async (c) => {
      const a = await access(user, i.id, c);
      needManage(a); live(a.ev);
      if (a.d.status !== 'active') throw conflict('Department is archived');
      return (await c.query(
        'INSERT INTO event_plans(event_id, department_id, title, goal, starts_on, ends_on, columns, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING *',
        [a.ev.id, a.d.id, i.title, i.goal ?? null, i.starts_on ?? null, i.ends_on ?? null, JSON.stringify(i.columns ?? DEFAULT_COLUMNS), user.id])).rows[0];
    });
  },
});

cap({
  name: 'list_event_plans', method: 'GET', path: '/events/:id/plans', tag: TAG,
  summary: 'Plans of an event with card counts per column. The organiser sees all; others see plans of departments they belong to.',
  input: z.object({ id, department_id: id.optional(), include_archived: z.coerce.boolean().default(false) }),
  async handler({ user }, i) {
    const ev = await mustFind('events', i.id);
    const s = await departmentScope(user, ev);
    const rows = await many(
      `SELECT p.*, d.name AS department, d.colour,
              coalesce((SELECT jsonb_object_agg(column_key, n) FROM (SELECT column_key, count(*)::int AS n FROM event_cards WHERE plan_id=p.id AND status='active' GROUP BY column_key) x), '{}') AS counts
         FROM event_plans p JOIN event_departments d ON d.id=p.department_id
        WHERE p.event_id=$1 AND ($2::uuid IS NULL OR p.department_id=$2) AND ($3 OR p.status='active') ORDER BY d.created_at, p.created_at`, [i.id, i.department_id ?? null, i.include_archived]);
    return s.organiser ? rows : rows.filter((p) => s.member.has(p.department_id) || s.led.has(p.department_id));
  },
});

cap({
  name: 'update_event_plan', method: 'PATCH', path: '/plans/:id', tag: TAG,
  summary: 'Edit a plan, rename or reorder its columns, or archive it (organiser or department lead). A column that still holds cards cannot be dropped: move the cards first.',
  input: z.object({ id, title: z.string().min(2).max(120).optional(), goal: z.string().max(1000).optional(), starts_on: date.optional(), ends_on: date.optional(), columns: z.array(column).min(2).max(8).optional(), archived: z.boolean().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const p = await loadPlan(i.id, c);
      const a = await access(user, p.department_id, c);
      needManage(a); live(a.ev);
      if (i.columns) {
        if (new Set(i.columns.map((x) => x.key)).size !== i.columns.length) throw badRequest('Column keys must be unique');
        const used = (await c.query("SELECT DISTINCT column_key FROM event_cards WHERE plan_id=$1 AND status='active'", [p.id])).rows.map((r) => r.column_key);
        const gone = used.filter((k) => !i.columns.some((x) => x.key === k));
        if (gone.length) throw conflict(`Columns ${gone.join(', ')} still hold cards; move them first`, { columns: gone });
      }
      if ((i.starts_on || i.ends_on) && (await c.query('SELECT coalesce($2::date, ends_on) < coalesce($1::date, starts_on) AS bad FROM event_plans WHERE id=$3', [i.starts_on ?? null, i.ends_on ?? null, p.id])).rows[0].bad) throw badRequest('ends_on is before starts_on');
      const status = i.archived === undefined ? null : i.archived ? 'archived' : 'active';
      return (await c.query(
        `UPDATE event_plans SET title=coalesce($2,title), goal=coalesce($3,goal), starts_on=coalesce($4,starts_on), ends_on=coalesce($5,ends_on), columns=coalesce($6::jsonb,columns),
           status=coalesce($7,status), archived_at=CASE WHEN $7='archived' THEN now() WHEN $7='active' THEN NULL ELSE archived_at END WHERE id=$1 RETURNING *`,
        [i.id, i.title ?? null, i.goal ?? null, i.starts_on ?? null, i.ends_on ?? null, i.columns ? JSON.stringify(i.columns) : null, status])).rows[0];
    });
  },
});

// ------------------------------------------------------------------ cards
const CARD_COLS = `c.*, (SELECT count(*)::int FROM event_card_comments m WHERE m.card_id=c.id) AS comment_count,
  (SELECT count(*)::int FROM jsonb_array_elements(c.checklist) x WHERE (x->>'done')::boolean) AS checklist_done, jsonb_array_length(c.checklist) AS checklist_total`;

cap({
  name: 'get_plan_board', method: 'GET', path: '/plans/:id/board', tag: TAG,
  summary: 'The kanban board of a plan: its columns each with their cards in order, assignee faces, and overdue flags. Visible to the department team and the organiser.',
  input: z.object({ id, mine: z.coerce.boolean().default(false).describe('only cards assigned to me') }),
  async handler({ user }, i) {
    const p = await loadPlan(i.id);
    const a = await access(user, p.department_id);
    needWork(a);
    const cards = await many(
      `SELECT ${CARD_COLS}, (c.due_on IS NOT NULL AND c.due_on < current_date AND c.column_key <> $2) AS overdue,
              coalesce((SELECT jsonb_agg(jsonb_build_object('id',u.id,'display_name',u.display_name,'avatar_emoji',u.avatar_emoji,'avatar_color',u.avatar_color,'avatar_url',u.avatar_url)) FROM users u WHERE u.id = ANY(c.assignee_ids)), '[]') AS assignees
         FROM event_cards c WHERE c.plan_id=$1 AND c.status='active' AND (NOT $3 OR $4 = ANY(c.assignee_ids)) ORDER BY c.position, c.created_at`, [p.id, doneKey(p), i.mine, user.id]);
    return { plan: p, department: { id: a.d.id, name: a.d.name, colour: a.d.colour }, can_manage: a.manage, columns: p.columns.map((col) => ({ ...col, cards: cards.filter((x) => x.column_key === col.key) })) };
  },
});

cap({
  name: 'create_event_card', method: 'POST', path: '/plans/:id/cards', tag: TAG, status: 201,
  summary: 'Add a task card to a plan (department team). Dates use start/end times and a due date; assignees must be active in the department and are notified.',
  input: z.object({ id, title: z.string().min(2).max(160), description: z.string().max(4000).optional(), column_key: key.optional(), priority: priority.default('normal'),
    starts_at: dt.optional(), ends_at: dt.optional(), due_on: date.optional(), assignee_ids: z.array(id).max(20).default([]), labels: z.array(z.string().min(1).max(24)).max(10).default([]), checklist: checklist.default([]) }),
  async handler({ user }, i) {
    if (i.starts_at && i.ends_at && i.ends_at < i.starts_at) throw badRequest('ends_at is before starts_at');
    return tx(async (c) => {
      const p = await loadPlan(i.id, c);
      if (p.status !== 'active') throw conflict('Plan is archived');
      const a = await access(user, p.department_id, c);
      needWork(a); live(a.ev);
      const col = i.column_key ?? p.columns[0].key;
      if (!hasColumn(p, col)) throw badRequest(`This plan has no column "${col}"`);
      await checkAssignees(c, p.department_id, i.assignee_ids);
      const card = (await c.query(
        `INSERT INTO event_cards(plan_id, department_id, event_id, column_key, title, description, priority, starts_at, ends_at, due_on, assignee_ids, labels, checklist, created_by, done_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, CASE WHEN $4=$15 THEN now() END) RETURNING *`,
        [p.id, p.department_id, p.event_id, col, i.title, i.description ?? null, i.priority, i.starts_at ?? null, i.ends_at ?? null, i.due_on ?? null, i.assignee_ids, i.labels, JSON.stringify(i.checklist), user.id, doneKey(p)])).rows[0];
      await place(c, p.id, col, card.id);
      await log(c, card.id, user.id, 'created', null, col);
      for (const uid of i.assignee_ids.filter((x) => x !== user.id)) await notify(c, uid, { kind: 'card_assigned', title: 'New task for you', body: `${a.ev.name} · ${a.d.name}: ${i.title}`, data: { event_id: a.ev.id, plan_id: p.id, card_id: card.id } });
      return card;
    });
  },
});

cap({
  name: 'update_event_card', method: 'PATCH', path: '/cards/:id', tag: TAG,
  summary: 'Edit a card (department team). Changing assignees notifies the newly added; ticking checklist items sends the whole list. archived=true removes it from the board but keeps it and its history.',
  input: z.object({ id, title: z.string().min(2).max(160).optional(), description: z.string().max(4000).optional(), priority: priority.optional(),
    starts_at: dt.optional(), ends_at: dt.optional(), due_on: date.optional(), assignee_ids: z.array(id).max(20).optional(), labels: z.array(z.string().min(1).max(24)).max(10).optional(), checklist: checklist.optional(), archived: z.boolean().optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const card = (await c.query('SELECT * FROM event_cards WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!card) throw notFound('Card');
      const a = await access(user, card.department_id, c);
      needWork(a); live(a.ev);
      const starts = i.starts_at ?? card.starts_at?.toISOString(), ends = i.ends_at ?? card.ends_at?.toISOString();
      if (starts && ends && ends < starts) throw badRequest('ends_at is before starts_at');
      if (i.assignee_ids) await checkAssignees(c, card.department_id, i.assignee_ids);
      const status = i.archived === undefined ? null : i.archived ? 'archived' : 'active';
      const out = (await c.query(
        `UPDATE event_cards SET title=coalesce($2,title), description=coalesce($3,description), priority=coalesce($4,priority), starts_at=coalesce($5,starts_at), ends_at=coalesce($6,ends_at), due_on=coalesce($7,due_on),
           assignee_ids=coalesce($8,assignee_ids), labels=coalesce($9,labels), checklist=coalesce($10::jsonb,checklist), status=coalesce($11,status), updated_at=now() WHERE id=$1 RETURNING *`,
        [i.id, i.title ?? null, i.description ?? null, i.priority ?? null, i.starts_at ?? null, i.ends_at ?? null, i.due_on ?? null, i.assignee_ids ?? null, i.labels ?? null, i.checklist ? JSON.stringify(i.checklist) : null, status])).rows[0];
      const added = (i.assignee_ids ?? []).filter((x) => !card.assignee_ids.includes(x) && x !== user.id);
      for (const uid of added) await notify(c, uid, { kind: 'card_assigned', title: 'New task for you', body: `${a.ev.name} · ${a.d.name}: ${out.title}`, data: { event_id: a.ev.id, plan_id: card.plan_id, card_id: card.id } });
      await log(c, card.id, user.id, i.archived === true ? 'archived' : i.archived === false ? 'restored' : added.length ? 'assigned' : 'edited');
      return out;
    });
  },
});

cap({
  name: 'move_event_card', method: 'POST', path: '/cards/:id/move', tag: TAG,
  summary: 'Move a card to another column and position (drag and drop). Moving into the last column marks it done; into a column named "blocked" needs a reason. Every move is kept in the card history.',
  input: z.object({ id, column_key: key, position: z.number().int().min(0).optional().describe('0 = top; omit to drop at the bottom'), reason: z.string().max(300).optional() }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const card = (await c.query('SELECT * FROM event_cards WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (!card || card.status !== 'active') throw notFound('Card');
      const p = await loadPlan(card.plan_id, c);
      const a = await access(user, card.department_id, c);
      needWork(a); live(a.ev);
      if (!hasColumn(p, i.column_key)) throw badRequest(`This plan has no column "${i.column_key}"`);
      if (i.column_key === 'blocked' && card.column_key !== 'blocked' && !i.reason) throw badRequest('Say what is blocking this card');
      const done = i.column_key === doneKey(p);
      await c.query(
        `UPDATE event_cards SET column_key=$2, blocked_reason=CASE WHEN $2='blocked' THEN coalesce($3, blocked_reason) ELSE NULL END,
           done_at=CASE WHEN $4 AND NOT $5 THEN now() WHEN NOT $4 THEN NULL ELSE done_at END, updated_at=now() WHERE id=$1`,
        [i.id, i.column_key, i.reason ?? null, done, card.column_key === doneKey(p)]);
      await place(c, p.id, i.column_key, card.id, i.position);
      if (card.column_key !== i.column_key) await log(c, card.id, user.id, 'moved', card.column_key, i.column_key, i.reason ?? null);
      if (done && card.column_key !== i.column_key && card.created_by !== user.id) await notify(c, card.created_by, { kind: 'card_done', title: 'Task done', body: `${a.d.name}: ${card.title}`, data: { event_id: a.ev.id, plan_id: p.id, card_id: card.id } });
      return (await c.query('SELECT * FROM event_cards WHERE id=$1', [i.id])).rows[0];
    });
  },
});

cap({
  name: 'comment_event_card', method: 'POST', path: '/cards/:id/comments', tag: TAG, status: 201,
  summary: 'Comment on a card (department team).', input: z.object({ id, body: z.string().min(1).max(2000) }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const card = (await c.query('SELECT * FROM event_cards WHERE id=$1', [i.id])).rows[0];
      if (!card) throw notFound('Card');
      const a = await access(user, card.department_id, c);
      needWork(a);
      const m = (await c.query('INSERT INTO event_card_comments(card_id, author_id, body) VALUES ($1,$2,$3) RETURNING *', [i.id, user.id, i.body])).rows[0];
      for (const uid of new Set([...card.assignee_ids, card.created_by])) if (uid !== user.id) await notify(c, uid, { kind: 'card_comment', title: `New comment on ${card.title}`, body: i.body.slice(0, 120), data: { event_id: card.event_id, card_id: card.id } });
      return m;
    });
  },
});

cap({
  name: 'get_event_card', method: 'GET', path: '/cards/:id', tag: TAG,
  summary: 'A card with its comments and move history (department team).', input: z.object({ id }),
  async handler({ user }, i) {
    const card = await one(`SELECT ${CARD_COLS} FROM event_cards c WHERE c.id=$1`, [i.id]);
    if (!card) throw notFound('Card');
    needWork(await access(user, card.department_id));
    const [comments, history] = await Promise.all([
      many(`SELECT m.id AS comment_id, m.card_id, m.body, m.created_at, ${PUBLIC_USER} FROM event_card_comments m JOIN users u ON u.id=m.author_id WHERE m.card_id=$1 ORDER BY m.created_at`, [i.id]),
      many('SELECT h.*, u.display_name AS actor_name FROM event_card_history h JOIN users u ON u.id=h.actor_id WHERE h.card_id=$1 ORDER BY h.at', [i.id]),
    ]);
    return { ...card, comments, history };
  },
});

// ------------------------------------------------------------------ schedules
cap({
  name: 'my_event_schedule', method: 'GET', path: '/me/event-schedule', tag: TAG,
  summary: 'Your tasks across every event and department, soonest first, with the department and event for each. Open (not done) cards only unless include_done.',
  input: z.object({ event_id: id.optional(), include_done: z.coerce.boolean().default(false) }),
  handler: ({ user }, i) => many(
    `SELECT c.id, c.title, c.priority, c.column_key, c.starts_at, c.ends_at, c.due_on, c.blocked_reason, (c.due_on IS NOT NULL AND c.due_on < current_date AND c.done_at IS NULL) AS overdue,
            d.id AS department_id, d.name AS department, d.colour, e.id AS event_id, e.name AS event, c.plan_id
       FROM event_cards c JOIN event_departments d ON d.id=c.department_id JOIN events e ON e.id=c.event_id JOIN event_plans p ON p.id=c.plan_id
      WHERE c.status='active' AND p.status='active' AND $1 = ANY(c.assignee_ids) AND ($2::uuid IS NULL OR c.event_id=$2) AND ($3 OR c.done_at IS NULL)
      ORDER BY coalesce(c.starts_at, c.due_on::timestamptz) NULLS LAST, c.created_at`, [user.id, i.event_id ?? null, i.include_done]),
});

cap({
  name: 'get_event_timeline', method: 'GET', path: '/events/:id/timeline', tag: TAG,
  summary: 'All dated cards of an event across departments, in time order, for a run-sheet view. The organiser sees every department; others only theirs.',
  input: z.object({ id, department_id: id.optional(), from: date.optional(), to: date.optional() }),
  async handler({ user }, i) {
    const ev = await mustFind('events', i.id);
    const s = await departmentScope(user, ev);
    if (!s.organiser && !s.member.size && !s.led.size) throw forbidden('You are not part of this event\'s departments');
    const rows = await many(
      `SELECT c.id, c.title, c.priority, c.column_key, c.starts_at, c.ends_at, c.due_on, c.assignee_ids, c.done_at, d.id AS department_id, d.name AS department, d.colour
         FROM event_cards c JOIN event_departments d ON d.id=c.department_id JOIN event_plans p ON p.id=c.plan_id
        WHERE c.event_id=$1 AND c.status='active' AND p.status='active' AND (c.starts_at IS NOT NULL OR c.due_on IS NOT NULL)
          AND ($2::uuid IS NULL OR c.department_id=$2) AND ($3::date IS NULL OR coalesce(c.starts_at::date, c.due_on) >= $3) AND ($4::date IS NULL OR coalesce(c.starts_at::date, c.due_on) <= $4)
        ORDER BY coalesce(c.starts_at, c.due_on::timestamptz), c.created_at`, [i.id, i.department_id ?? null, i.from ?? null, i.to ?? null]);
    return s.organiser ? rows : rows.filter((r) => s.member.has(r.department_id) || s.led.has(r.department_id));
  },
});
