// Team workspace: master team + per-event/tournament sub-teams, a team task board (tasks, subtasks, comments, files)
// and event/match attendance (RSVP, captain confirmation, check-in).
// Nothing is deleted: tasks are archived, members who leave are marked 'left', sub-teams are archived via update_team.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one, many, query, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { mustFind, PUBLIC_USER } from '../helpers.js';
import { notify } from '../notify.js';
import { requireConsent } from '../youth.js';
import { canManageTeam } from './teams.js';

const STATUSES = ['new', 'in_progress', 'review', 'done'];
const status = z.enum(STATUSES);
const rsvp = z.enum(['going', 'maybe', 'no']);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const fileUrl = z.string().max(2000).refine((u) => u.startsWith('/api/v1/media/') || /^https:\/\//.test(u), 'Use a /api/v1/media/… path or an https URL');

const isActive = (teamId, userId, c) => (c ?? { query }).query("SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2 AND status='active'", [teamId, userId]).then((r) => !!r.rows[0]);

/** manager, or an active member of the team */
async function access(user, teamId) {
  const team = await mustFind('teams', teamId);
  const manager = await canManageTeam(user, team);
  if (!manager && !(await isActive(teamId, user.id))) throw forbidden('Team members only');
  return { team, manager };
}
async function mustManage(user, teamId) {
  const team = await mustFind('teams', teamId);
  if (!(await canManageTeam(user, team))) throw forbidden('Only the team owner or managers can do this');
  return team;
}

// ------------------------------------------------------------------ master team and sub-teams

cap({
  name: 'create_sub_team', method: 'POST', path: '/teams/:id/sub-teams', tag: 'Team workspace', status: 201,
  summary: 'Create a sub-team of a master team for one event or tournament. By default it starts with the same roster as the master team; send member_ids to pick different players (they must be on the master roster). The master owner and managers run it.',
  input: z.object({
    id, name: z.string().min(2).max(60).optional().describe('default: "<master> · <event>"'), event_id: id.optional(),
    copy_roster: z.boolean().default(true).describe('start with the whole active master roster'),
    member_ids: z.array(id).max(80).optional().describe('only these master-roster members (overrides copy_roster)'),
  }),
  async handler({ user }, i) {
    const master = await mustManage(user, i.id);
    if (master.kind !== 'master') throw badRequest('Sub-teams hang off a master team');
    const ev = i.event_id ? await mustFind('events', i.event_id) : null;
    return tx(async (c) => {
      const roster = (await c.query("SELECT user_id, role, jersey_no, position FROM team_members WHERE team_id=$1 AND status='active'", [master.id])).rows;
      const byUser = new Map(roster.map((r) => [r.user_id, r]));
      let picked = i.member_ids ? [...new Set(i.member_ids)] : i.copy_roster ? roster.map((r) => r.user_id) : [];
      const strangers = picked.filter((u) => !byUser.has(u));
      if (strangers.length) throw badRequest('Sub-team players must be on the master team roster', { user_ids: strangers });
      picked = picked.filter((u) => u !== master.owner_id);
      for (const u of picked) await requireConsent(u, 'participation', 'playing in a sub-team', c);
      const name = i.name ?? (ev ? `${master.name} · ${ev.name}`.slice(0, 60) : `${master.name} B`.slice(0, 60));
      const sub = (await c.query(
        `INSERT INTO teams(name, sport_id, owner_id, emoji, color, city, currency, organisation_id, parent_team_id, kind, event_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'sub',$10) RETURNING *`,
        [name, master.sport_id, master.owner_id, master.emoji, master.color, master.city, master.currency, master.organisation_id, master.id, ev?.id ?? null])).rows[0];
      await c.query("INSERT INTO team_members(team_id, user_id, role) VALUES ($1,$2,'manager')", [sub.id, master.owner_id]);
      for (const u of picked) {
        const m = byUser.get(u);
        await c.query('INSERT INTO team_members(team_id, user_id, role, jersey_no, position, invited_by) VALUES ($1,$2,$3,$4,$5,$6)', [sub.id, u, m.role, m.jersey_no, m.position, user.id]);
      }
      return { ...sub, members: picked.length + 1 };
    });
  },
});

cap({
  name: 'list_sub_teams', method: 'GET', path: '/teams/:id/sub-teams', tag: 'Team workspace',
  summary: 'The sub-teams of a master team (event/tournament squads) with their event and headcount.', input: z.object({ id, include_archived: z.coerce.boolean().optional() }),
  async handler({ user }, i) {
    await access(user, i.id);
    return many(
      `SELECT s.id, s.name, s.emoji, s.color, s.event_id, e.name AS event_name, e.starts_on, s.archived_at,
              (SELECT count(*)::int FROM team_members m WHERE m.team_id=s.id AND m.status='active') AS members
         FROM teams s LEFT JOIN events e ON e.id=s.event_id WHERE s.parent_team_id=$1 AND ($2::boolean OR s.archived_at IS NULL) ORDER BY e.starts_on NULLS LAST, s.created_at DESC`, [i.id, !!i.include_archived]);
  },
});

cap({
  name: 'set_sub_team_roster', method: 'POST', path: '/teams/:id/sub-roster', tag: 'Team workspace',
  summary: 'Choose who plays for a sub-team. The list becomes its active roster (everyone must be on the master roster); others are marked as left, never deleted. The owner always stays.',
  input: z.object({ id, user_ids: z.array(id).max(80) }),
  async handler({ user }, i) {
    const sub = await mustManage(user, i.id);
    if (sub.kind !== 'sub') throw badRequest('This is not a sub-team');
    const ids = [...new Set(i.user_ids)].filter((u) => u !== sub.owner_id);
    return tx(async (c) => {
      const master = new Map((await c.query("SELECT user_id, role, jersey_no, position FROM team_members WHERE team_id=$1 AND status='active'", [sub.parent_team_id])).rows.map((r) => [r.user_id, r]));
      const strangers = ids.filter((u) => !master.has(u));
      if (strangers.length) throw badRequest('Sub-team players must be on the master team roster', { user_ids: strangers });
      const current = new Set((await c.query("SELECT user_id FROM team_members WHERE team_id=$1 AND status='active'", [sub.id])).rows.map((r) => r.user_id));
      for (const u of ids.filter((x) => !current.has(x))) await requireConsent(u, 'participation', 'playing in a sub-team', c);
      await c.query("UPDATE team_members SET status='left' WHERE team_id=$1 AND status<>'left' AND user_id<>$3 AND NOT (user_id = ANY($2::uuid[]))", [sub.id, ids, sub.owner_id]);
      for (const u of ids) {
        const m = master.get(u);
        await c.query(
          `INSERT INTO team_members(team_id, user_id, role, jersey_no, position, invited_by) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (team_id, user_id) DO UPDATE SET status='active'`, [sub.id, u, m.role, m.jersey_no, m.position, user.id]);
      }
      return (await c.query(`SELECT ${PUBLIC_USER}, m.role AS team_role, m.jersey_no, m.position FROM team_members m JOIN users u ON u.id=m.user_id WHERE m.team_id=$1 AND m.status='active' ORDER BY u.display_name`, [sub.id])).rows;
    });
  },
});

// ------------------------------------------------------------------ task board

const TASK_LIST = `
  SELECT t.id, t.team_id, t.title, t.description, t.status, t.tags, t.due_on::text AS due_on, t.position, t.created_by, t.created_at, t.updated_at,
         coalesce((SELECT json_agg(json_build_object('id', u.id, 'handle', u.handle, 'display_name', u.display_name, 'avatar_emoji', u.avatar_emoji, 'avatar_color', u.avatar_color, 'avatar_url', u.avatar_url) ORDER BY u.display_name)
                     FROM team_task_assignees a JOIN users u ON u.id=a.user_id WHERE a.task_id=t.id), '[]') AS assignees,
         (SELECT count(*)::int FROM team_task_subtasks s WHERE s.task_id=t.id) AS subtasks_total,
         (SELECT count(*)::int FROM team_task_subtasks s WHERE s.task_id=t.id AND s.done) AS subtasks_done,
         (SELECT count(*)::int FROM team_task_comments k WHERE k.task_id=t.id) AS comments,
         (SELECT count(*)::int FROM team_task_files f WHERE f.task_id=t.id) AS files
    FROM team_tasks t`;

async function loadTask(user, taskId) {
  const t = await one('SELECT * FROM team_tasks WHERE id=$1 AND archived_at IS NULL', [taskId]);
  if (!t) throw notFound('Task');
  const { team, manager } = await access(user, t.team_id);
  const assigned = !!(await one('SELECT 1 FROM team_task_assignees WHERE task_id=$1 AND user_id=$2', [taskId, user.id]));
  return { task: t, team, manager, assigned, canEdit: manager || assigned || t.created_by === user.id };
}

async function setAssignees(c, team, task, ids, actor) {
  const want = [...new Set(ids)];
  if (want.length) {
    const ok = new Set((await c.query("SELECT user_id FROM team_members WHERE team_id=$1 AND status='active' AND user_id = ANY($2::uuid[])", [team.id, want])).rows.map((r) => r.user_id));
    const bad = want.filter((u) => !ok.has(u));
    if (bad.length) throw badRequest('Only active team members can be assigned', { user_ids: bad });
  }
  const before = new Set((await c.query('SELECT user_id FROM team_task_assignees WHERE task_id=$1', [task.id])).rows.map((r) => r.user_id));
  await c.query('DELETE FROM team_task_assignees WHERE task_id=$1 AND NOT (user_id = ANY($2::uuid[]))', [task.id, want]); // join rows only; no user data
  for (const u of want) await c.query('INSERT INTO team_task_assignees(task_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [task.id, u]);
  for (const u of want.filter((x) => !before.has(x) && x !== actor.id)) {
    await notify(c, u, { kind: 'team_task_assigned', title: `${team.name}: you were assigned "${task.title}"`, body: '', data: { team_id: team.id, task_id: task.id } });
  }
}

cap({
  name: 'list_team_tasks', method: 'GET', path: '/teams/:id/tasks', tag: 'Team workspace',
  summary: 'The team task board: tasks grouped into new / in_progress / review / done columns, plus each member\'s open-task count for the assign picker. Filter with mine, q or tag.',
  input: z.object({ id, mine: z.coerce.boolean().optional(), q: z.string().max(80).optional(), tag: z.string().max(30).optional(), include_done: z.coerce.boolean().default(true) }),
  async handler({ user }, i) {
    const { team, manager } = await access(user, i.id);
    const tasks = await many(
      `${TASK_LIST} WHERE t.team_id=$1 AND t.archived_at IS NULL
          AND ($2::boolean IS NOT TRUE OR EXISTS (SELECT 1 FROM team_task_assignees a WHERE a.task_id=t.id AND a.user_id=$3))
          AND ($4::text IS NULL OR t.title ILIKE '%'||$4||'%') AND ($5::text IS NULL OR $5 = ANY(t.tags)) AND ($6::boolean OR t.status<>'done')
        ORDER BY t.position, t.created_at DESC LIMIT 500`, [i.id, !!i.mine, user.id, i.q ?? null, i.tag ?? null, i.include_done]);
    const columns = Object.fromEntries(STATUSES.map((s) => [s, tasks.filter((t) => t.status === s)]));
    const workload = await many(
      `SELECT ${PUBLIC_USER}, m.role AS team_role, (SELECT count(*)::int FROM team_task_assignees a JOIN team_tasks t ON t.id=a.task_id WHERE a.user_id=u.id AND t.team_id=$1 AND t.archived_at IS NULL AND t.status<>'done') AS open_tasks
         FROM team_members m JOIN users u ON u.id=m.user_id WHERE m.team_id=$1 AND m.status='active' ORDER BY u.display_name`, [i.id]);
    return { team_id: team.id, can_manage: manager, columns, workload };
  },
});

cap({
  name: 'get_team_task', method: 'GET', path: '/team-tasks/:task_id', tag: 'Team workspace',
  summary: 'One task with its subtasks, comments and attached files.', input: z.object({ task_id: id }),
  async handler({ user }, i) {
    const { canEdit } = await loadTask(user, i.task_id);
    const task = await one(`${TASK_LIST} WHERE t.id=$1`, [i.task_id]);
    const [subtasks, comments, files] = await Promise.all([
      many('SELECT id, title, done, position FROM team_task_subtasks WHERE task_id=$1 ORDER BY position, created_at', [i.task_id]),
      many(`SELECT k.id, k.body, k.created_at, ${PUBLIC_USER} FROM team_task_comments k JOIN users u ON u.id=k.user_id WHERE k.task_id=$1 ORDER BY k.created_at`, [i.task_id]),
      many('SELECT id, name, url, content_type, size_bytes, uploaded_by, created_at FROM team_task_files WHERE task_id=$1 ORDER BY created_at', [i.task_id]),
    ]);
    return { ...task, can_edit: canEdit, subtasks, comments, files };
  },
});

cap({
  name: 'create_team_task', method: 'POST', path: '/teams/:id/tasks', tag: 'Team workspace', status: 201,
  summary: 'Add a task to the team board (kit, transport, fees, drills…). Any active member can; assignees are notified.',
  input: z.object({
    id, title: z.string().trim().min(2).max(140), description: z.string().max(2000).optional(), status: status.default('new'),
    tags: z.array(z.string().trim().min(1).max(30)).max(6).default([]), due_on: date.optional(), assignee_ids: z.array(id).max(20).default([]),
    subtasks: z.array(z.string().trim().min(1).max(140)).max(30).default([]),
  }),
  async handler({ user }, i) {
    const { team } = await access(user, i.id);
    return tx(async (c) => {
      const pos = (await c.query("SELECT coalesce(max(position),0)+1 AS p FROM team_tasks WHERE team_id=$1 AND status=$2", [team.id, i.status])).rows[0].p;
      const t = (await c.query('INSERT INTO team_tasks(team_id, title, description, status, tags, due_on, position, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
        [team.id, i.title, i.description ?? null, i.status, [...new Set(i.tags)], i.due_on ?? null, pos, user.id])).rows[0];
      for (const [n, s] of i.subtasks.entries()) await c.query('INSERT INTO team_task_subtasks(task_id, title, position) VALUES ($1,$2,$3)', [t.id, s, n]);
      await setAssignees(c, team, t, i.assignee_ids, user);
      return (await c.query(`${TASK_LIST} WHERE t.id=$1`, [t.id])).rows[0];
    });
  },
});

cap({
  name: 'update_team_task', method: 'PATCH', path: '/team-tasks/:task_id', tag: 'Team workspace',
  summary: 'Edit, move (status) or re-assign a task. Managers, the task\'s creator and its assignees can; assigning others is manager-only.',
  input: z.object({
    task_id: id, title: z.string().trim().min(2).max(140).optional(), description: z.string().max(2000).nullable().optional(), status: status.optional(),
    tags: z.array(z.string().trim().min(1).max(30)).max(6).optional(), due_on: date.nullable().optional(), assignee_ids: z.array(id).max(20).optional(),
  }),
  async handler({ user }, i) {
    const { task, team, manager, canEdit } = await loadTask(user, i.task_id);
    if (!canEdit) throw forbidden('Only managers, the task creator or its assignees can edit it');
    if (i.assignee_ids && !manager && task.created_by !== user.id) throw forbidden('Only managers or the task creator can change who is assigned');
    return tx(async (c) => {
      const sets = [], vals = [i.task_id];
      for (const [col, v] of [['title', i.title], ['description', i.description], ['status', i.status], ['due_on', i.due_on], ['tags', i.tags && [...new Set(i.tags)]]]) {
        if (v !== undefined) { vals.push(v); sets.push(`${col}=$${vals.length}`); }
      }
      if (i.status && i.status !== task.status) { // land at the bottom of the new column
        vals.push((await c.query('SELECT coalesce(max(position),0)+1 AS p FROM team_tasks WHERE team_id=$1 AND status=$2', [task.team_id, i.status])).rows[0].p);
        sets.push(`position=$${vals.length}`);
      }
      if (!sets.length && !i.assignee_ids) throw badRequest('Nothing to update');
      if (sets.length) await c.query(`UPDATE team_tasks SET ${sets.join(', ')}, updated_at=now() WHERE id=$1`, vals);
      if (i.assignee_ids) await setAssignees(c, team, task, i.assignee_ids, user);
      return (await c.query(`${TASK_LIST} WHERE t.id=$1`, [i.task_id])).rows[0];
    });
  },
});

cap({
  name: 'archive_team_task', method: 'DELETE', path: '/team-tasks/:task_id', tag: 'Team workspace',
  summary: 'Archive a task (hidden from the board, kept in the database). Managers and the task creator.', input: z.object({ task_id: id }),
  async handler({ user }, i) {
    const { task, manager } = await loadTask(user, i.task_id);
    if (!manager && task.created_by !== user.id) throw forbidden('Only managers or the task creator can archive it');
    await query('UPDATE team_tasks SET archived_at=now(), updated_at=now() WHERE id=$1', [i.task_id]);
    return { ok: true };
  },
});

cap({
  name: 'add_task_subtask', method: 'POST', path: '/team-tasks/:task_id/subtasks', tag: 'Team workspace', status: 201,
  summary: 'Add a checklist item to a task.', input: z.object({ task_id: id, title: z.string().trim().min(1).max(140) }),
  async handler({ user }, i) {
    const { canEdit } = await loadTask(user, i.task_id);
    if (!canEdit) throw forbidden();
    return one('INSERT INTO team_task_subtasks(task_id, title, position) VALUES ($1,$2,(SELECT coalesce(max(position),0)+1 FROM team_task_subtasks WHERE task_id=$1)) RETURNING id, title, done, position', [i.task_id, i.title]);
  },
});

cap({
  name: 'update_task_subtask', method: 'PATCH', path: '/team-task-subtasks/:subtask_id', tag: 'Team workspace',
  summary: 'Tick or rename a checklist item.', input: z.object({ subtask_id: id, done: z.boolean().optional(), title: z.string().trim().min(1).max(140).optional() }),
  async handler({ user }, i) {
    const s = await mustFind('team_task_subtasks', i.subtask_id);
    const { canEdit } = await loadTask(user, s.task_id);
    if (!canEdit) throw forbidden();
    if (i.done === undefined && i.title === undefined) throw badRequest('Nothing to update');
    return one('UPDATE team_task_subtasks SET done=coalesce($2,done), title=coalesce($3,title) WHERE id=$1 RETURNING id, title, done, position', [i.subtask_id, i.done ?? null, i.title ?? null]);
  },
});

cap({
  name: 'comment_on_task', method: 'POST', path: '/team-tasks/:task_id/comments', tag: 'Team workspace', status: 201,
  summary: 'Comment on a task. Assignees and the creator are notified.', input: z.object({ task_id: id, body: z.string().trim().min(1).max(1000) }),
  async handler({ user }, i) {
    const { task, team } = await loadTask(user, i.task_id);
    await requireConsent(user.id, 'contact', 'commenting on team tasks');
    return tx(async (c) => {
      const k = (await c.query('INSERT INTO team_task_comments(task_id, user_id, body) VALUES ($1,$2,$3) RETURNING id, body, created_at', [i.task_id, user.id, i.body])).rows[0];
      const who = new Set([task.created_by, ...(await c.query('SELECT user_id FROM team_task_assignees WHERE task_id=$1', [i.task_id])).rows.map((r) => r.user_id)]);
      who.delete(user.id);
      for (const u of who) await notify(c, u, { kind: 'team_task_comment', title: `${user.display_name} commented on "${task.title}"`, body: i.body.slice(0, 140), data: { team_id: team.id, task_id: task.id } });
      return k;
    });
  },
});

cap({
  name: 'attach_task_file', method: 'POST', path: '/team-tasks/:task_id/files', tag: 'Team workspace', status: 201,
  summary: 'Attach a file to a task by reference (an uploaded media path or an https link, with its name and size).',
  input: z.object({ task_id: id, name: z.string().trim().min(1).max(200), url: fileUrl, content_type: z.string().max(100).optional(), size_bytes: z.number().int().min(0).optional() }),
  async handler({ user }, i) {
    const { canEdit } = await loadTask(user, i.task_id);
    if (!canEdit) throw forbidden();
    return one('INSERT INTO team_task_files(task_id, name, url, content_type, size_bytes, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, url, content_type, size_bytes, created_at',
      [i.task_id, i.name, i.url, i.content_type ?? null, i.size_bytes ?? null, user.id]);
  },
});

// ------------------------------------------------------------------ attendance

/** exactly one of event_id / fixture_id, and the team (or its master) must take part */
async function attendanceScope(team, i) {
  if (!!i.event_id === !!i.fixture_id) throw badRequest('Give either event_id or fixture_id');
  const ids = [team.id, team.parent_team_id].filter(Boolean);
  if (i.fixture_id) {
    const f = await one('SELECT * FROM fixtures WHERE id=$1', [i.fixture_id]);
    if (!f) throw notFound('Fixture');
    if (!ids.includes(f.home_team_id) && !ids.includes(f.away_team_id)) throw badRequest('Your team is not playing in that fixture');
    return { event_id: f.event_id, fixture_id: f.id };
  }
  await mustFind('events', i.event_id);
  const entered = team.event_id === i.event_id || (await one("SELECT 1 FROM event_entries WHERE event_id=$1 AND team_id = ANY($2::uuid[]) AND status IN ('pending','accepted')", [i.event_id, ids]));
  if (!entered) throw badRequest('Your team is not entered in that event');
  return { event_id: i.event_id, fixture_id: null };
}

const where = 'a.team_id=$1 AND a.event_id IS NOT DISTINCT FROM $2 AND a.fixture_id IS NOT DISTINCT FROM $3';

cap({
  name: 'set_event_rsvp', method: 'POST', path: '/teams/:id/attendance', tag: 'Team attendance',
  summary: 'Tell the team whether you are coming to an event or match (going / maybe / no). Managers are notified when someone says no.',
  input: z.object({ id, event_id: id.optional(), fixture_id: id.optional(), rsvp, note: z.string().max(200).optional() }),
  async handler({ user }, i) {
    const team = await mustFind('teams', i.id);
    if (!(await isActive(team.id, user.id))) throw forbidden('Only active team members can RSVP');
    const s = await attendanceScope(team, i);
    const row = await one(
      `INSERT INTO team_attendance(team_id, event_id, fixture_id, user_id, rsvp, note, responded_at) VALUES ($1,$2,$3,$4,$5,$6,now())
       ON CONFLICT (team_id, event_id, fixture_id, user_id) DO UPDATE SET rsvp=EXCLUDED.rsvp, note=EXCLUDED.note, responded_at=now(),
         confirmed_by=CASE WHEN team_attendance.rsvp=EXCLUDED.rsvp THEN team_attendance.confirmed_by ELSE NULL END,
         confirmed_at=CASE WHEN team_attendance.rsvp=EXCLUDED.rsvp THEN team_attendance.confirmed_at ELSE NULL END
       RETURNING id, team_id, event_id, fixture_id, rsvp, note, responded_at, confirmed_at, checked_in_at`,
      [team.id, s.event_id, s.fixture_id, user.id, i.rsvp, i.note ?? null]);
    if (i.rsvp === 'no' && team.owner_id !== user.id) await notify(null, team.owner_id, { kind: 'team_attendance_no', title: `${user.display_name} can't make it (${team.name})`, body: i.note ?? '', data: { team_id: team.id, event_id: s.event_id, fixture_id: s.fixture_id } });
    return row;
  },
});

cap({
  name: 'request_attendance', method: 'POST', path: '/teams/:id/attendance/request', tag: 'Team attendance',
  summary: 'Ask the roster (or the selected squad only) to RSVP for an event or match. Everyone gets a "pending" row and a notification. Owner/managers.',
  input: z.object({ id, event_id: id.optional(), fixture_id: id.optional(), squad_only: z.boolean().default(false) }),
  async handler({ user }, i) {
    const team = await mustManage(user, i.id);
    const s = await attendanceScope(team, i);
    return tx(async (c) => {
      const people = (await c.query(
        `SELECT m.user_id FROM team_members m WHERE m.team_id=$1 AND m.status='active'
            AND (NOT $4::boolean OR EXISTS (SELECT 1 FROM team_squads q WHERE q.team_id=m.team_id AND q.user_id=m.user_id AND q.status IN ('selected','confirmed')
                                              AND q.event_id IS NOT DISTINCT FROM $2 AND q.fixture_id IS NOT DISTINCT FROM $3))`, [team.id, s.event_id, s.fixture_id, i.squad_only])).rows.map((r) => r.user_id);
      const label = s.fixture_id ? 'a match' : (await c.query('SELECT name FROM events WHERE id=$1', [s.event_id])).rows[0].name;
      let asked = 0;
      for (const u of people) {
        const r = await c.query('INSERT INTO team_attendance(team_id, event_id, fixture_id, user_id) VALUES ($1,$2,$3,$4) ON CONFLICT (team_id, event_id, fixture_id, user_id) DO NOTHING', [team.id, s.event_id, s.fixture_id, u]);
        if (r.rowCount && u !== user.id) {
          asked++;
          await notify(c, u, { kind: 'team_attendance_request', title: `${team.name}: are you coming to ${label}?`, body: 'Open the team schedule and answer going / maybe / no.', data: { team_id: team.id, event_id: s.event_id, fixture_id: s.fixture_id } });
        }
      }
      return { asked, total: people.length };
    });
  },
});

cap({
  name: 'list_event_attendance', method: 'GET', path: '/teams/:id/attendance', tag: 'Team attendance',
  summary: 'Attendance for an event or match: every active member with their RSVP (pending until they answer), captain confirmation and check-in, plus counts.',
  input: z.object({ id, event_id: id.optional(), fixture_id: id.optional() }),
  async handler({ user }, i) {
    const { team, manager } = await access(user, i.id);
    const s = await attendanceScope(team, i);
    const people = await many(
      `SELECT ${PUBLIC_USER}, m.role AS team_role, m.jersey_no, m.availability, coalesce(a.rsvp,'pending') AS rsvp, ${manager ? 'a.note,' : ''} a.responded_at, a.confirmed_at, a.checked_in_at,
              q.status AS squad_status
         FROM team_members m JOIN users u ON u.id=m.user_id
         LEFT JOIN team_attendance a ON a.team_id=m.team_id AND a.user_id=m.user_id AND a.event_id IS NOT DISTINCT FROM $2 AND a.fixture_id IS NOT DISTINCT FROM $3
         LEFT JOIN team_squads q ON q.team_id=m.team_id AND q.user_id=m.user_id AND q.event_id IS NOT DISTINCT FROM $2 AND q.fixture_id IS NOT DISTINCT FROM $3 AND q.status<>'dropped'
        WHERE m.team_id=$1 AND m.status='active' ORDER BY m.jersey_no NULLS LAST, u.display_name`, [team.id, s.event_id, s.fixture_id]);
    const n = (f) => people.filter(f).length;
    return {
      team_id: team.id, event_id: s.event_id, fixture_id: s.fixture_id, can_manage: manager, people,
      counts: { going: n((p) => p.rsvp === 'going'), maybe: n((p) => p.rsvp === 'maybe'), no: n((p) => p.rsvp === 'no'), pending: n((p) => p.rsvp === 'pending'), confirmed: n((p) => !!p.confirmed_at), checked_in: n((p) => !!p.checked_in_at), total: people.length },
    };
  },
});

cap({
  name: 'confirm_attendance', method: 'PATCH', path: '/teams/:id/attendance/:user_id', tag: 'Team attendance',
  summary: 'Captain/manager confirms (or un-confirms) that a player is attending. Only possible once the player has said "going" or "maybe".',
  input: z.object({ id, user_id: id, event_id: id.optional(), fixture_id: id.optional(), confirmed: z.boolean().default(true) }),
  async handler({ user }, i) {
    const team = await mustManage(user, i.id);
    const s = await attendanceScope(team, i);
    const a = await one(`SELECT * FROM team_attendance a WHERE ${where} AND a.user_id=$4`, [team.id, s.event_id, s.fixture_id, i.user_id]);
    if (!a || a.rsvp === 'pending' || a.rsvp === 'no') throw conflict('The player has not said they are coming');
    const r = await one(
      `UPDATE team_attendance SET confirmed_by=CASE WHEN $2::boolean THEN $3::uuid END, confirmed_at=CASE WHEN $2::boolean THEN now() END WHERE id=$1 RETURNING id, user_id, rsvp, confirmed_at, checked_in_at`, [a.id, i.confirmed, user.id]);
    if (i.confirmed && i.user_id !== user.id) await notify(null, i.user_id, { kind: 'team_attendance_confirmed', title: `${team.name}: your attendance is confirmed`, body: '', data: { team_id: team.id, event_id: s.event_id, fixture_id: s.fixture_id } });
    return r;
  },
});

cap({
  name: 'check_in_attendee', method: 'POST', path: '/teams/:id/attendance/:user_id/check-in', tag: 'Team attendance',
  summary: 'Mark a player as arrived (or undo it) on the day. Owner/managers; works even if the player never RSVP\'d.',
  input: z.object({ id, user_id: id, event_id: id.optional(), fixture_id: id.optional(), checked_in: z.boolean().default(true) }),
  async handler({ user }, i) {
    const team = await mustManage(user, i.id);
    const s = await attendanceScope(team, i);
    if (!(await isActive(team.id, i.user_id))) throw badRequest('Only active team members can be checked in');
    return one(
      `INSERT INTO team_attendance(team_id, event_id, fixture_id, user_id, checked_in_at, checked_in_by) VALUES ($1,$2,$3,$4,CASE WHEN $5::boolean THEN now() END,CASE WHEN $5::boolean THEN $6::uuid END)
       ON CONFLICT (team_id, event_id, fixture_id, user_id) DO UPDATE SET checked_in_at=EXCLUDED.checked_in_at, checked_in_by=EXCLUDED.checked_in_by
       RETURNING id, user_id, rsvp, confirmed_at, checked_in_at`, [team.id, s.event_id, s.fixture_id, i.user_id, i.checked_in, user.id]);
  },
});

// ------------------------------------------------------------------ workspace summary (right rail)

cap({
  name: 'get_team_workspace', method: 'GET', path: '/teams/:id/workspace', tag: 'Team workspace',
  summary: 'Everything the team workspace header and side rail need in one call: upcoming events/matches with my RSVP, board counts, my open tasks and the sub-teams.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { team, manager } = await access(user, i.id);
    const ids = [team.id, team.parent_team_id].filter(Boolean);
    const [fixtures, events, board, mine, sub_teams, master] = await Promise.all([
      many(`SELECT f.id AS fixture_id, f.event_id, e.name AS event_name, f.round, f.scheduled_at, th.name AS home_name, ta.name AS away_name, (SELECT a.rsvp FROM team_attendance a WHERE a.team_id=$1 AND a.user_id=$2 AND a.fixture_id=f.id) AS my_rsvp
              FROM fixtures f JOIN events e ON e.id=f.event_id LEFT JOIN teams th ON th.id=f.home_team_id LEFT JOIN teams ta ON ta.id=f.away_team_id
             WHERE (f.home_team_id = ANY($3::uuid[]) OR f.away_team_id = ANY($3::uuid[])) AND f.status IN ('scheduled','live') AND f.scheduled_at >= now() - interval '1 day' ORDER BY f.scheduled_at LIMIT 10`, [team.id, user.id, ids]),
      many(`SELECT e.id AS event_id, e.name, e.kind, e.starts_on, e.ends_on, (SELECT a.rsvp FROM team_attendance a WHERE a.team_id=$1 AND a.user_id=$2 AND a.event_id=e.id AND a.fixture_id IS NULL) AS my_rsvp
              FROM events e WHERE e.status NOT IN ('completed','cancelled') AND (e.id = $4 OR EXISTS (SELECT 1 FROM event_entries en WHERE en.event_id=e.id AND en.team_id = ANY($3::uuid[]) AND en.status IN ('pending','accepted')))
             ORDER BY e.starts_on NULLS LAST LIMIT 10`, [team.id, user.id, ids, team.event_id]),
      many("SELECT status, count(*)::int AS n FROM team_tasks WHERE team_id=$1 AND archived_at IS NULL GROUP BY status", [team.id]),
      one("SELECT count(*)::int AS n FROM team_task_assignees a JOIN team_tasks t ON t.id=a.task_id WHERE t.team_id=$1 AND a.user_id=$2 AND t.archived_at IS NULL AND t.status<>'done'", [team.id, user.id]),
      many('SELECT id, name, emoji, color, event_id FROM teams WHERE parent_team_id=$1 AND archived_at IS NULL ORDER BY created_at DESC', [team.id]),
      team.parent_team_id ? one('SELECT id, name, emoji, color FROM teams WHERE id=$1', [team.parent_team_id]) : null,
    ]);
    return {
      team_id: team.id, kind: team.kind, can_manage: manager, master_team: master, sub_teams,
      board: Object.fromEntries(STATUSES.map((s) => [s, board.find((b) => b.status === s)?.n ?? 0])), my_open_tasks: mine.n,
      schedule: { fixtures, events },
    };
  },
});
