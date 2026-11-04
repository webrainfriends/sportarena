// Academy academics & school integration (#783), part 2: school attendance summaries, grading frameworks, attainment snapshots, coordination tasks, and the
// bulk / partner submission path. Same rules as part 1 (src/academy-academics.js); grades are encrypted, restricted to academic_records staff and the family,
// and every read of them is audit-logged.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { flag } from '../academy.js';
import { notify } from '../notify.js';
import { orgFor } from '../org-access.js';
import { shareLive, settingsFor } from '../academy-clashes.js';
import { academicsAccess, linkFor, insertAttendance, insertSnapshot, attendanceInput, snapshotInput, importRow, applyRows, currentAttendance, pctOf, exceptionOf, snapshotView, seal, open, CTX, SOURCE_LABEL, TASK_KINDS, AUDIENCES, day } from '../academy-academics.js';

const TAG = 'Academy academics';
const idem = z.string().min(8).max(80);

// ------------------------------------------------------------------ school attendance
cap({
  name: 'record_academy_school_attendance', method: 'POST', path: '/academy/school-links/:id/attendance', tag: TAG, status: 201,
  summary: 'Record a school-attendance summary for a period (sessions possible, present, authorised and unauthorised absence, late) with its source and reference. Append-only: re-recording a period supersedes it and keeps the earlier figure. If it falls below the academy\'s threshold, or unauthorised absence reaches the limit, one follow-up task is raised (and withdrawn if a correction clears it). Needs the athlete / guardian to have allowed the school timetable and attendance.',
  input: z.object({ id }).merge(attendanceInput),
  handler: ({ user }, { id: linkId, ...i }) => tx(async (c) => {
    const { link } = await linkFor(user, linkId, { write: true, c });
    return insertAttendance(c, link, i, { actor: user.id });
  }),
});

cap({
  name: 'list_academy_school_attendance', method: 'GET', path: '/academy/school-links/:id/attendance', tag: TAG,
  summary: 'Current school-attendance figures of a linked athlete, newest period first, each with percentage, source and whether it breaches the academy\'s rules. Only while the timetable / attendance share is live. Needs academics access.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const { link } = await linkFor(user, i.id, { c: pool });
    if (!(await shareLive(pool, link.organisation_id, link.athlete_id, 'schedule'))) return { link_id: link.id, shared: false, periods: [] };
    const settings = await settingsFor(pool, link.organisation_id);
    const rows = await currentAttendance(pool, link.id);
    return { link_id: link.id, shared: true, settings, periods: rows.map((r) => ({ id: r.id, period_from: r.period_from, period_to: r.period_to, percent: pctOf(r), sessions_possible: r.sessions_possible, present: r.present, authorised_absence: r.authorised_absence, unauthorised_absence: r.unauthorised_absence, late: r.late, source: r.source, source_label: SOURCE_LABEL[r.source], source_ref: r.source_ref, exceptions: exceptionOf(r, settings), recorded_at: r.created_at })) };
  },
});

// ------------------------------------------------------------------ grading frameworks
export const PRESETS = [
  { key: 'gcse_9_1', name: 'GCSE 9–1', kind: 'band', scale: { grades: ['9', '8', '7', '6', '5', '4', '3', '2', '1', 'U'] }, pass_mark: '4' },
  { key: 'a_level', name: 'A-level A*–E', kind: 'letter', scale: { grades: ['A*', 'A', 'B', 'C', 'D', 'E', 'U'] }, pass_mark: 'E' },
  { key: 'ib_1_7', name: 'IB 7–1', kind: 'band', scale: { grades: ['7', '6', '5', '4', '3', '2', '1'] }, pass_mark: '4' },
  { key: 'cbse_grades', name: 'CBSE grades A1–E', kind: 'letter', scale: { grades: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'D', 'E'] }, pass_mark: 'D' },
  { key: 'percentage', name: 'Percentage', kind: 'percent', scale: { min: 0, max: 100 }, pass_mark: '40' },
  { key: 'gpa_4', name: 'GPA 4.0 scale', kind: 'points', scale: { min: 0, max: 4 }, pass_mark: '2' },
];
const scale = z.union([z.object({ grades: z.array(z.string().trim().min(1).max(12)).min(2).max(30) }), z.object({ min: z.number(), max: z.number() }).refine((v) => v.max > v.min, 'max must exceed min')]);

cap({
  name: 'list_academy_academic_frameworks', method: 'GET', path: '/organisations/:id/academy/academics/frameworks', tag: TAG,
  summary: 'The academy\'s grading frameworks (latest version of each) plus ready-made scales (GCSE, A-level, IB, CBSE, percentage, GPA) to start from. Scales hold no personal data. Needs academics access.',
  input: z.object({ id }),
  async handler({ user }, i) {
    await academicsAccess(user, i.id);
    const frameworks = await many('SELECT DISTINCT ON (key) id, key, version, name, kind, scale, pass_mark, created_at FROM academy_academic_frameworks WHERE organisation_id=$1 ORDER BY key, version DESC', [i.id]);
    return { frameworks, presets: PRESETS };
  },
});

cap({
  name: 'save_academy_academic_framework', method: 'POST', path: '/organisations/:id/academy/academics/frameworks', tag: TAG, status: 201,
  summary: 'Create a grading framework, or a new version of one by key. Versions are immutable and every snapshot embeds the version it used, so changing a scale never rewrites past results. Needs academic_records access.',
  input: z.object({ id, key: z.string().regex(/^[a-z0-9_]{2,40}$/), name: z.string().trim().min(2).max(80), kind: z.enum(['letter', 'percent', 'points', 'band']), scale, pass_mark: z.string().trim().max(12).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    await academicsAccess(user, i.id, { write: true, c, need: 'academic_records' });
    if (((i.kind === 'letter' || i.kind === 'band') && !i.scale.grades) || ((i.kind === 'percent' || i.kind === 'points') && i.scale.min == null)) throw badRequest('The scale does not match the framework kind');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`fw:${i.id}:${i.key}`]);
    const v = ((await c.query('SELECT max(version) AS v FROM academy_academic_frameworks WHERE organisation_id=$1 AND key=$2', [i.id, i.key])).rows[0].v ?? 0) + 1;
    const r = (await c.query('INSERT INTO academy_academic_frameworks(organisation_id, key, version, name, kind, scale, pass_mark, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [i.id, i.key, v, i.name, i.kind, JSON.stringify(i.scale), i.pass_mark ?? null, user.id])).rows[0];
    await audit(c, user.id, 'save_academic_framework', 'academy_academic_frameworks', r.id);
    return r;
  }),
});

// ------------------------------------------------------------------ attainment snapshots
cap({
  name: 'record_academy_academic_snapshot', method: 'POST', path: '/academy/school-links/:id/snapshots', tag: TAG, status: 201,
  summary: 'Record an attainment / progress snapshot for a term from a school report or a verified entry: subject grades checked against the chosen framework, the educator\'s overall standing, who may see it (education staff only, or the athlete / guardian too), and mandatory provenance (source, reference, date). Immutable and versioned per term: a correction is a new version. Encrypted at rest. Needs academic_records access and the athlete / guardian\'s permission to hold school progress.',
  input: z.object({ id, idempotency_key: idem }).merge(snapshotInput),
  handler: ({ user }, { id: linkId, idempotency_key, ...i }) => tx(async (c) => {
    const { link } = await linkFor(user, linkId, { write: true, c, need: 'academic_records' });
    return insertSnapshot(c, link, { ...i, idempotency_key }, { actor: user.id });
  }),
});

cap({
  name: 'list_academy_academic_snapshots', method: 'GET', path: '/academy/school-links/:id/snapshots', tag: TAG,
  summary: 'The versions of a linked athlete\'s progress snapshots, newest first. Academic_records staff (while the athlete / guardian\'s progress permission is live) see grades, standing and comments — each read is audit-logged. Other academics staff see that a snapshot exists, its term, source and date, marked restricted, and nothing else.',
  input: z.object({ id, all_versions: flag.default(false) }),
  handler: async ({ user }, i) => tx(async (c) => {
    const { link, a } = await linkFor(user, i.id, { c });
    const shared = await shareLive(c, link.organisation_id, link.athlete_id, 'progress');
    if (!shared) return { link_id: link.id, shared: false, snapshots: [] };
    const rows = (await c.query(`SELECT ${i.all_versions ? '' : 'DISTINCT ON (lower(term_label))'} s.* FROM academy_academic_snapshots s WHERE s.link_id=$1 ORDER BY lower(s.term_label), s.version DESC`, [link.id])).rows;
    rows.sort((x, y) => String(y.period_to).localeCompare(String(x.period_to)) || y.version - x.version);
    const snaps = [];
    for (const s of rows) snaps.push({ ...(await snapshotView(c, s, user.id, { full: a.records })), recorded_by: s.recorded_by });
    return { link_id: link.id, shared: true, snapshots: snaps, can_read_grades: a.records };
  }),
});

// ------------------------------------------------------------------ coordination tasks
const taskRow = (t, full) => ({ id: t.id, athlete_id: t.athlete_id, athlete_name: t.athlete_name, link_id: t.link_id, kind: t.kind, audience: t.audience, title: t.title, priority: t.priority, due_on: t.due_on, status: t.status, assignee_id: t.assignee_id, assignee_name: t.assignee_name ?? null, source_type: t.source_type, overdue: ['open', 'in_progress'].includes(t.status) && t.due_on && new Date(t.due_on) < new Date(new Date().toISOString().slice(0, 10)), note: full ? open(CTX.note, t.note_enc) : undefined, row_version: t.row_version, created_at: t.created_at });
const TASK_SQL = 'SELECT t.*, u.display_name AS athlete_name, au.display_name AS assignee_name FROM academy_academic_tasks t JOIN users u ON u.id=t.athlete_id LEFT JOIN users au ON au.id=t.assignee_id';

cap({
  name: 'save_academy_academic_task', method: 'POST', path: '/organisations/:id/academy/academic-tasks', tag: TAG, status: 201,
  summary: 'Create a coordination task for an athlete with a coach, the school, the guardian or the education team (liaison, a guardian meeting, a tutoring plan, a report due, an exam clash or attendance follow-up). The title is plain wording; the optional note is encrypted personal text. Tasks must not contain grades. The assignee must be an active member of the academy and is told in generic wording. Needs academics access.',
  input: z.object({ id, athlete_id: id, link_id: id.optional(), kind: z.enum(TASK_KINDS), audience: z.enum(AUDIENCES), title: z.string().trim().min(3).max(120), note: z.string().trim().max(1000).optional(), priority: z.enum(['low', 'normal', 'high']).default('normal'), due_on: day.optional(), assignee_id: id.optional(), idempotency_key: idem }),
  handler: ({ user }, i) => tx(async (c) => {
    await academicsAccess(user, i.id, { write: true, c });
    if (!(await c.query("SELECT 1 FROM academy_school_links WHERE organisation_id=$1 AND athlete_id=$2 AND status='active' AND ($3::uuid IS NULL OR id=$3)", [i.id, i.athlete_id, i.link_id ?? null])).rowCount) throw notFound('School link');
    if (i.assignee_id && !(await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [i.id, i.assignee_id])).rowCount) throw badRequest('The assignee must be an active member of this academy');
    const src = `manual:${user.id}:${i.idempotency_key}`;
    const prior = (await c.query("SELECT * FROM academy_academic_tasks WHERE organisation_id=$1 AND source_type='manual' AND source_id=$2", [i.id, src])).rows[0];
    if (prior) return { id: prior.id, replayed: true };
    const r = (await c.query(
      `INSERT INTO academy_academic_tasks(organisation_id, athlete_id, link_id, kind, audience, title, note_enc, priority, due_on, assignee_id, source_type, source_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'manual',$11,$12) RETURNING id`,
      [i.id, i.athlete_id, i.link_id ?? null, i.kind, i.audience, i.title, seal(CTX.note, i.note), i.priority, i.due_on ?? null, i.assignee_id ?? null, src, user.id])).rows[0];
    await audit(c, user.id, 'create_academic_task', 'academy_academic_tasks', r.id);
    if (i.assignee_id && i.assignee_id !== user.id) await notify(c, i.assignee_id, { kind: 'academy_academic_task', title: 'A coordination task was assigned to you', body: 'Open Gotmygame to see it.', data: { organisation_id: i.id, task_id: r.id }, dedupe_key: `academy:atask:${r.id}` });
    return taskRow((await c.query(`${TASK_SQL} WHERE t.id=$1`, [r.id])).rows[0], true);
  }),
});

cap({
  name: 'update_academy_academic_task', method: 'PATCH', path: '/academy/academic-tasks/:id', tag: TAG,
  summary: 'Progress, reassign, reschedule or close a coordination task. The assignee may update their own task; academics staff may update any. Completing records who and when; nothing is deleted. Optimistic concurrency by row_version.',
  input: z.object({ id, row_version: z.number().int().min(1), status: z.enum(['open', 'in_progress', 'done', 'cancelled']).optional(), assignee_id: id.nullable().optional(), due_on: day.nullable().optional(), priority: z.enum(['low', 'normal', 'high']).optional(), note: z.string().trim().max(1000).nullable().optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const t = (await c.query('SELECT * FROM academy_academic_tasks WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!t) throw notFound('Task');
    const mine = t.assignee_id === user.id;
    let staff = false;
    try { await academicsAccess(user, t.organisation_id, { write: true, c }); staff = true; } catch (e) { if (!mine) throw (e.status === 404 ? notFound('Task') : e); }
    if (!staff && (i.assignee_id !== undefined || i.due_on !== undefined || i.priority !== undefined)) throw forbidden('Only academics staff can reassign or reschedule a task');
    if (t.row_version !== i.row_version) throw conflict('This task changed since you opened it', { code: 'stale', current_row_version: t.row_version });
    if (i.assignee_id && !(await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [t.organisation_id, i.assignee_id])).rowCount) throw badRequest('The assignee must be an active member of this academy');
    const has = (k) => i[k] !== undefined;
    const closing = i.status && ['done', 'cancelled'].includes(i.status) && !['done', 'cancelled'].includes(t.status);
    await c.query(
      `UPDATE academy_academic_tasks SET status=coalesce($2,status), assignee_id=CASE WHEN $3::boolean THEN $4 ELSE assignee_id END, due_on=CASE WHEN $5::boolean THEN $6 ELSE due_on END, priority=coalesce($7,priority),
              note_enc=CASE WHEN $8::boolean THEN $9 ELSE note_enc END, completed_by=CASE WHEN $10::boolean THEN $11 ELSE completed_by END, completed_at=CASE WHEN $10::boolean THEN now() ELSE completed_at END, row_version=row_version+1, updated_at=now() WHERE id=$1`,
      [t.id, i.status ?? null, has('assignee_id'), i.assignee_id ?? null, has('due_on'), i.due_on ?? null, i.priority ?? null, has('note'), seal(CTX.note, i.note), !!closing, user.id]);
    if (has('assignee_id') && i.assignee_id && i.assignee_id !== user.id) await notify(c, i.assignee_id, { kind: 'academy_academic_task', title: 'A coordination task was assigned to you', body: 'Open Gotmygame to see it.', data: { organisation_id: t.organisation_id, task_id: t.id }, dedupe_key: `academy:atask:${t.id}:${i.assignee_id}` });
    await audit(c, user.id, 'update_academic_task', 'academy_academic_tasks', t.id);
    return taskRow((await c.query(`${TASK_SQL} WHERE t.id=$1`, [t.id])).rows[0], staff || mine);
  }),
});

cap({
  name: 'list_academy_academic_tasks', method: 'GET', path: '/organisations/:id/academy/academic-tasks', tag: TAG,
  summary: 'Coordination tasks, soonest due first. Academics staff see all; any other member sees only tasks assigned to them (athlete, kind, due date and note — never grades). Filter by status, audience, athlete or `mine`.',
  input: z.object({ id, status: z.enum(['active', 'done', 'cancelled', 'all']).default('active'), audience: z.enum(AUDIENCES).optional(), athlete_id: id.optional(), mine: flag.default(false), ...page }),
  async handler({ user }, i) {
    const { role } = await orgFor(user, i.id);
    let staff = true;
    try { await academicsAccess(user, i.id); } catch (e) { if (e.status !== 403) throw e; staff = false; }
    const only = staff ? i.mine : true;
    const where = `t.organisation_id=$1 AND ($2::boolean IS FALSE OR t.assignee_id=$3) AND ($4::text='all' OR ($4='active' AND t.status IN ('open','in_progress')) OR t.status=$4) AND ($5::text IS NULL OR t.audience=$5) AND ($6::uuid IS NULL OR t.athlete_id=$6)`;
    const args = [i.id, only, user.id, i.status, i.audience ?? null, i.athlete_id ?? null];
    const rows = await many(`${TASK_SQL} WHERE ${where} ORDER BY (t.status IN ('done','cancelled')), t.due_on NULLS LAST, t.created_at, t.id LIMIT $7 OFFSET $8`, [...args, i.limit, i.offset]);
    const total = (await one(`SELECT count(*)::int AS n FROM academy_academic_tasks t WHERE ${where}`, args)).n;
    return { tasks: rows.map((t) => taskRow(t, staff || t.assignee_id === user.id)), total, scope: staff ? 'all' : 'assigned_to_me', role };
  },
});

// ------------------------------------------------------------------ bulk and partner submission
const rowsInput = z.array(importRow).min(1).max(500);

async function run(c, args) {
  const results = await applyRows(c, args.rows, args);
  const bad = results.filter((r) => !r.ok);
  return { mode: args.dry ? 'preview' : 'commit', rows: results.length, accepted: results.length - bad.length, rejected: bad.length, results };
}

async function withReplay(c, orgId, user, key, channel, fn) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`aimp:${orgId}:${user.id}:${key}`]);
  const prior = (await c.query('SELECT result FROM academy_academic_imports WHERE organisation_id=$1 AND submitted_by=$2 AND idempotency_key=$3', [orgId, user.id, key])).rows[0];
  if (prior) return { ...prior.result, replayed: true };
  const out = await fn();
  if (out.mode === 'commit' && out.rejected === 0) await c.query('INSERT INTO academy_academic_imports(organisation_id, submitted_by, idempotency_key, channel, result) VALUES ($1,$2,$3,$4,$5)', [orgId, user.id, key, channel, JSON.stringify(out)]);
  return out;
}

cap({
  name: 'import_academy_school_records', method: 'POST', path: '/organisations/:id/academy/school-records/import', tag: TAG,
  summary: 'Academy staff: enter school timetable blocks, attendance summaries and (with academic_records) attainment snapshots in bulk, by link or by the school\'s student reference. `preview` validates every row and writes nothing; `commit` is all-or-nothing and idempotent per idempotency_key. Entries are recorded as "entered and verified by the academy" (or school-confirmed when you hold the school\'s confirmation) with your name, and every row goes through the same checks, consent gates and audit as the single-record capabilities.',
  input: z.object({ id, mode: z.enum(['preview', 'commit']).default('preview'), rows: rowsInput, idempotency_key: idem }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = await academicsAccess(user, i.id, { write: true, c });
    const links = (await c.query("SELECT l.* FROM academy_school_links l WHERE l.organisation_id=$1 AND l.status='active'", [i.id])).rows;
    const go = () => run(c, { rows: i.rows, links, actor: user.id, channel: 'manual', canRecords: a.records, dry: i.mode === 'preview', sourceFor: (_t, s) => (s === 'school_confirmed' ? 'school_confirmed' : 'manual_verified') });
    const out = i.mode === 'preview' ? await go() : await withReplay(c, i.id, user, i.idempotency_key, 'manual', go);
    if (out.mode === 'commit' && out.rejected && !out.replayed) throw conflict('Some rows were rejected, so nothing was saved. Fix them or preview first.', { results: out.results });
    return out;
  }),
});

cap({
  name: 'submit_school_records', method: 'POST', path: '/organisations/:id/school-records', tag: TAG,
  summary: 'School partner API: an owner or admin of a verified school (the :id is the school organisation) submits timetable blocks, attendance summaries and attainment snapshots for students the academy linked to it AND authorised the school to submit for (import_authorised), using the school\'s own student reference. Only while the athlete / guardian\'s permission is live; records are marked "imported from the school" with the school as source. `preview` validates only; `commit` is all-or-nothing and idempotent. Usable with an organisation-scoped API token.',
  input: z.object({ id, mode: z.enum(['preview', 'commit']).default('preview'), rows: rowsInput.refine((r) => r.every((x) => x.student_ref), 'Every row needs the school\'s student_ref'), idempotency_key: idem }),
  handler: ({ user }, i) => tx(async (c) => {
    const { org } = await orgFor(user, i.id, ['owner', 'admin'], { write: true, c });
    if (!['school', 'college', 'university'].includes(org.kind)) throw forbidden('Only a school, college or university can submit school records');
    const links = (await c.query("SELECT l.* FROM academy_school_links l WHERE l.school_org_id=$1 AND l.status='active' AND l.import_authorised", [i.id])).rows;
    if (!links.length) throw conflict('No academy has authorised this school to submit records yet');
    // the actor is the school's user; rows are recorded for the academy that owns each link, so the academy is looked up per link, not trusted from the caller
    const go = () => run(c, { rows: i.rows, links, actor: user.id, channel: 'partner', canRecords: true, dry: i.mode === 'preview', sourceFor: () => 'partner_import' });
    const out = i.mode === 'preview' ? await go() : await withReplay(c, i.id, user, i.idempotency_key, 'partner', go);
    if (out.mode === 'commit' && out.rejected && !out.replayed) throw conflict('Some rows were rejected, so nothing was saved.', { results: out.results });
    return out;
  }),
});
