// Academy academics (#783): the rules shared by the REST / OpenAPI / MCP capabilities, the partner submission and the bulk import, so there is exactly
// one implementation of "record a school block / attendance summary / attainment snapshot". Nothing here stores a school, a person or a session of
// its own: a school is an `organisations` row, an athlete a `users` row, the sport timetable `academy_sessions`.
import { z } from 'zod';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { encrypt, decrypt } from './crypto.js';
import { audit } from './helpers.js';
import { opsAccess } from './academy-ops.js';
import { shareLive, settingsFor, BLOCK_KINDS } from './academy-clashes.js';
import { fromLocal } from './booking/time.js';
import { validTimezone } from './booking/time.js';

export { BLOCK_KINDS };
export const SOURCES = ['school_confirmed', 'manual_verified', 'partner_import'];
export const SNAPSHOT_SOURCES = ['school_report', 'manual_verified', 'partner_import'];
export const SOURCE_LABEL = { school_confirmed: 'Confirmed by the school', manual_verified: 'Entered and verified by the academy', partner_import: 'Imported from the school', school_report: 'School report' };
export const PROVISIONS = ['partner_school', 'on_site', 'online', 'tutoring_provider'];
export const TASK_KINDS = ['attendance_exception', 'exam_clash', 'coach_school_liaison', 'guardian_meeting', 'report_due', 'tutoring_support', 'other'];
export const AUDIENCES = ['coach', 'school', 'guardian', 'education'];

export const day = z.string().date();
export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time such as 09:30');
const TZ = z.string().min(1).max(60).refine(validTimezone, 'Unknown time zone');

export const blockInput = z.object({
  kind: z.enum(BLOCK_KINDS), label: z.string().trim().min(1).max(120).optional(),
  recurrence: z.enum(['once', 'weekly']),
  starts_at: z.string().datetime({ offset: true }).optional(), ends_at: z.string().datetime({ offset: true }).optional(),
  weekday: z.number().int().min(0).max(6).optional(), start_time: hhmm.optional(), end_time: hhmm.optional(), valid_from: day.optional(), valid_to: day.optional(), skip_dates: z.array(day).max(60).default([]),
  timezone: TZ.default('UTC'), source: z.enum(SOURCES).default('manual_verified'), source_ref: z.string().trim().min(2).max(120).optional(),
});
export const attendanceInput = z.object({
  period_from: day, period_to: day, sessions_possible: z.number().int().min(1).max(500), present: z.number().int().min(0).max(500),
  authorised_absence: z.number().int().min(0).max(500).default(0), unauthorised_absence: z.number().int().min(0).max(500).default(0), late: z.number().int().min(0).max(500).default(0),
  source: z.enum(SOURCES).default('manual_verified'), source_ref: z.string().trim().min(2).max(120).optional(),
});
export const snapshotInput = z.object({
  term_label: z.string().trim().min(2).max(40), period_from: day, period_to: day, framework_id: z.string().uuid().optional(), framework_key: z.string().regex(/^[a-z0-9_]{2,40}$/).optional(),
  entries: z.array(z.object({ subject: z.string().trim().min(2).max(80), grade: z.string().trim().min(1).max(12), target: z.string().trim().max(12).optional(), effort: z.number().int().min(1).max(5).optional() })).min(1).max(20),
  comment: z.string().trim().max(1500).optional(), standing: z.enum(['on_track', 'watch', 'concern']), visibility: z.enum(['education_staff', 'athlete_guardian']).default('athlete_guardian'),
  source: z.enum(SNAPSHOT_SOURCES).default('manual_verified'), source_ref: z.string().trim().min(2).max(120), source_date: day,
});

// personal free text and grades: encrypted, column-bound
export const seal = (ctx, v) => (v == null || v === '' ? null : encrypt(typeof v === 'string' ? v : JSON.stringify(v), ctx));
export const open = (ctx, s, json = false) => (s ? (json ? JSON.parse(decrypt(s, ctx)) : decrypt(s, ctx)) : null);
export const CTX = { label: 'academy_school_blocks.label', ref: 'academy_school_links.student_ref', entries: 'academy_academic_snapshots.entries', comment: 'academy_academic_snapshots.comment', note: 'academy_academic_tasks.note' };

/** The caller's live operations access plus the academics grants. 404 for outsiders (orgFor), 403 for a member without the grant. */
export async function academicsAccess(user, orgId, { write = false, c, need = 'academics' } = {}) {
  const a = await opsAccess(user, orgId, { write, c });
  if (need) a.need(need);
  a.records = a.has('academic_records');
  return a;
}

/** A link plus the caller's access to its academy (404 when it is not theirs). */
export async function linkFor(user, linkId, { write = false, c, need = 'academics' } = {}) {
  const link = (await c.query('SELECT l.*, o.name AS school_name, u.display_name AS athlete_name FROM academy_school_links l JOIN organisations o ON o.id=l.school_org_id JOIN users u ON u.id=l.athlete_id WHERE l.id=$1' + (write ? ' FOR UPDATE OF l' : ''), [linkId])).rows[0];
  if (!link) throw notFound('School link');
  const a = await academicsAccess(user, link.organisation_id, { write, c, need });
  return { link, a };
}

export const requireShare = async (c, link, level) => {
  if (link.status !== 'active') throw conflict('This school link has ended');
  if (!(await shareLive(c, link.organisation_id, link.athlete_id, level))) {
    throw conflict(level === 'progress' ? 'The athlete or a verified guardian has not allowed the academy to hold school progress' : 'The athlete or a verified guardian has not allowed the academy to hold school timetable and attendance',
      { code: 'academic_share_required', level });
  }
};

/** Eligible school: an active, platform-approved school / college / university organisation (the verified institution; never a copy). */
export async function eligibleSchool(c, schoolOrgId, academyId) {
  const s = (await c.query("SELECT id, name, kind, city, status, approval_status FROM organisations WHERE id=$1 AND kind IN ('school','college','university')", [schoolOrgId])).rows[0];
  if (!s || s.id === academyId || s.status !== 'active') throw notFound('School');
  if (s.approval_status !== 'approved') throw conflict('That school has not been verified by the platform team yet');
  return s;
}

// ------------------------------------------------------------------ blocks
export function normaliseBlock(i) {
  if (i.recurrence === 'once') {
    if (!i.starts_at || !i.ends_at) throw badRequest('A one-off block needs starts_at and ends_at');
    if (new Date(i.ends_at) <= new Date(i.starts_at)) throw badRequest('The block must end after it starts');
  } else {
    for (const k of ['weekday', 'start_time', 'end_time', 'valid_from', 'valid_to']) if (i[k] == null) throw badRequest(`A weekly block needs ${k}`);
    if (i.end_time <= i.start_time) throw badRequest('The block must end after it starts');
    if (i.valid_to < i.valid_from) throw badRequest('valid_to must not be before valid_from');
  }
  if (i.kind === 'exam' && i.recurrence === 'weekly') throw badRequest('An exam is a one-off block');
}

export async function insertBlock(c, link, i, { actor }) {
  normaliseBlock(i);
  await requireShare(c, link, 'schedule');
  // the same commitment recorded twice (a re-sent feed, a double tap) is one block
  const dup = (await c.query(
    `SELECT * FROM academy_school_blocks WHERE link_id=$1 AND status='active' AND kind=$2 AND recurrence=$3 AND starts_at IS NOT DISTINCT FROM $4 AND ends_at IS NOT DISTINCT FROM $5 AND weekday IS NOT DISTINCT FROM $6
        AND start_time IS NOT DISTINCT FROM $7 AND end_time IS NOT DISTINCT FROM $8 AND valid_from IS NOT DISTINCT FROM $9 AND valid_to IS NOT DISTINCT FROM $10 LIMIT 1`,
    [link.id, i.kind, i.recurrence, i.starts_at ?? null, i.ends_at ?? null, i.weekday ?? null, i.start_time ?? null, i.end_time ?? null, i.valid_from ?? null, i.valid_to ?? null])).rows[0];
  if (dup) return { ...dup, duplicate: true };
  const r = (await c.query(
    `INSERT INTO academy_school_blocks(organisation_id, link_id, athlete_id, kind, label_enc, recurrence, starts_at, ends_at, weekday, start_time, end_time, valid_from, valid_to, skip_dates, timezone, source, source_ref, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
    [link.organisation_id, link.id, link.athlete_id, i.kind, seal(CTX.label, i.label), i.recurrence, i.starts_at ?? null, i.ends_at ?? null, i.weekday ?? null, i.start_time ?? null, i.end_time ?? null, i.valid_from ?? null, i.valid_to ?? null, i.skip_dates ?? [], i.timezone ?? 'UTC', i.source, i.source_ref ?? null, actor])).rows[0];
  await audit(c, actor, 'record_school_block', 'academy_school_blocks', r.id);
  return r;
}

export const blockView = (b, withLabel) => ({
  id: b.id, link_id: b.link_id, athlete_id: b.athlete_id, kind: b.kind, recurrence: b.recurrence, starts_at: b.starts_at, ends_at: b.ends_at, weekday: b.weekday,
  start_time: b.start_time?.slice(0, 5) ?? null, end_time: b.end_time?.slice(0, 5) ?? null, valid_from: b.valid_from, valid_to: b.valid_to, skip_dates: b.skip_dates, timezone: b.timezone,
  source: b.source, source_label: SOURCE_LABEL[b.source], source_ref: b.source_ref, status: b.status, label: withLabel ? open(CTX.label, b.label_enc) : undefined,
});

/** Dated occurrences of a block inside [from, to] (inclusive dates), at most 92 days. Weekly blocks honour their term and skipped dates in their own zone. */
export function occurrences(b, from, to) {
  const out = [];
  if (b.recurrence === 'once') {
    const s = new Date(b.starts_at), e = new Date(b.ends_at);
    if (e >= new Date(`${from}T00:00:00Z`) && s <= new Date(`${to}T23:59:59Z`)) out.push({ block_id: b.id, kind: b.kind, starts_at: s.toISOString(), ends_at: e.toISOString() });
    return out;
  }
  const hm = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  for (let d = new Date(`${from}T00:00:00Z`), end = new Date(`${to}T00:00:00Z`), n = 0; d <= end && n < 93; d = new Date(d.getTime() + 86400000), n++) {
    const ds = d.toISOString().slice(0, 10);
    if (d.getUTCDay() !== b.weekday || ds < String(b.valid_from).slice(0, 10) || ds > String(b.valid_to).slice(0, 10) || (b.skip_dates ?? []).some((x) => String(x).slice(0, 10) === ds)) continue;
    out.push({ block_id: b.id, kind: b.kind, starts_at: fromLocal(ds, hm(b.start_time), b.timezone).toISOString(), ends_at: fromLocal(ds, hm(b.end_time), b.timezone).toISOString() });
  }
  return out;
}

// ------------------------------------------------------------------ attendance + exceptions
export const pctOf = (r) => Math.round((r.present / r.sessions_possible) * 1000) / 10;

/** Latest figure per period of a link (a correction supersedes; the history stays). */
export const currentAttendance = async (c, linkId) => (await c.query(
  `SELECT DISTINCT ON (period_from, period_to) * FROM academy_school_attendance WHERE link_id=$1 ORDER BY period_from DESC, period_to DESC, created_at DESC, id DESC`, [linkId])).rows;

export function exceptionOf(row, settings) {
  const reasons = [];
  const pct = pctOf(row);
  if (pct < settings.attendance_threshold_pct) reasons.push(`Attendance ${pct}% is below the ${settings.attendance_threshold_pct}% threshold`);
  if (row.unauthorised_absence >= settings.unauthorised_limit && settings.unauthorised_limit > 0) reasons.push(`${row.unauthorised_absence} unauthorised absences (limit ${settings.unauthorised_limit})`);
  return reasons;
}

export async function insertAttendance(c, link, i, { actor }) {
  if (i.period_to < i.period_from) throw badRequest('period_to must not be before period_from');
  if (i.present + i.authorised_absence + i.unauthorised_absence > i.sessions_possible) throw badRequest('Present plus absences cannot exceed the sessions possible');
  await requireShare(c, link, 'schedule');
  const prev = (await c.query('SELECT id FROM academy_school_attendance WHERE link_id=$1 AND period_from=$2 AND period_to=$3 ORDER BY created_at DESC, id DESC LIMIT 1', [link.id, i.period_from, i.period_to])).rows[0];
  const r = (await c.query(
    `INSERT INTO academy_school_attendance(organisation_id, link_id, athlete_id, period_from, period_to, sessions_possible, present, authorised_absence, unauthorised_absence, late, source, source_ref, recorded_by, supersedes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [link.organisation_id, link.id, link.athlete_id, i.period_from, i.period_to, i.sessions_possible, i.present, i.authorised_absence, i.unauthorised_absence, i.late, i.source, i.source_ref ?? null, actor, prev?.id ?? null])).rows[0];
  await audit(c, actor, 'record_school_attendance', 'academy_school_attendance', r.id);
  const settings = await settingsFor(c, link.organisation_id);
  const reasons = exceptionOf(r, settings);
  const sourceId = `${link.id}:${r.period_from.toISOString?.().slice(0, 10) ?? String(r.period_from).slice(0, 10)}`;
  if (reasons.length) {
    await c.query(
      `INSERT INTO academy_academic_tasks(organisation_id, athlete_id, link_id, kind, audience, title, priority, due_on, source_type, source_id, created_by)
       VALUES ($1,$2,$3,'attendance_exception','education','School attendance needs follow-up','high', current_date + 7,'school_attendance',$4,$5) ON CONFLICT DO NOTHING`, [link.organisation_id, link.athlete_id, link.id, sourceId, actor]);
  } else {
    await c.query("UPDATE academy_academic_tasks SET status='cancelled', updated_at=now(), row_version=row_version+1 WHERE organisation_id=$1 AND source_type='school_attendance' AND source_id=$2 AND status IN ('open','in_progress')", [link.organisation_id, sourceId]);
  }
  return { ...r, percent: pctOf(r), exception: reasons };
}

// ------------------------------------------------------------------ snapshots
export function checkGrade(framework, grade) {
  const sc = framework.scale;
  if (framework.kind === 'letter' || framework.kind === 'band') { if (!sc.grades.includes(grade)) throw badRequest(`"${grade}" is not a grade in ${framework.name}`, { allowed: sc.grades }); return; }
  const n = Number(grade);
  if (!Number.isFinite(n) || n < sc.min || n > sc.max) throw badRequest(`"${grade}" is outside ${framework.name} (${sc.min} to ${sc.max})`);
}

export async function insertSnapshot(c, link, i, { actor }) {
  if (i.period_to < i.period_from) throw badRequest('period_to must not be before period_from');
  await requireShare(c, link, 'progress');
  if (!i.framework_id && !i.framework_key) throw badRequest('Choose a grading framework (framework_id or framework_key)');
  const fw = (await c.query('SELECT * FROM academy_academic_frameworks WHERE organisation_id=$1 AND (id=$2 OR ($2::uuid IS NULL AND key=$3)) ORDER BY version DESC LIMIT 1', [link.organisation_id, i.framework_id ?? null, i.framework_key ?? null])).rows[0];
  if (!fw) throw notFound('Grading framework');
  if (i.idempotency_key) {
    const seen = (await c.query('SELECT id, term_label, version, source, source_ref, source_date, visibility, created_at FROM academy_academic_snapshots WHERE recorded_by=$1 AND idempotency_key=$2', [actor, i.idempotency_key])).rows[0];
    if (seen) return { ...seen, replayed: true };
  }
  for (const e of i.entries) { checkGrade(fw, e.grade); if (e.target) checkGrade(fw, e.target); }
  if (new Set(i.entries.map((e) => e.subject.toLowerCase())).size !== i.entries.length) throw badRequest('A subject appears twice in this snapshot');
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`snap:${link.id}:${i.term_label.toLowerCase()}`]);
  const prev = (await c.query('SELECT id, version FROM academy_academic_snapshots WHERE link_id=$1 AND lower(term_label)=lower($2) ORDER BY version DESC LIMIT 1', [link.id, i.term_label])).rows[0];
  const r = (await c.query(
    `INSERT INTO academy_academic_snapshots(organisation_id, link_id, athlete_id, term_label, period_from, period_to, framework_id, framework_snapshot, entries_enc, comment_enc, standing, visibility, source, source_ref, source_date, version, supersedes, recorded_by, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id, term_label, version, source, source_ref, source_date, visibility, created_at`,
    [link.organisation_id, link.id, link.athlete_id, i.term_label, i.period_from, i.period_to, fw.id, JSON.stringify({ key: fw.key, version: fw.version, name: fw.name, kind: fw.kind, scale: fw.scale, pass_mark: fw.pass_mark }),
      seal(CTX.entries, i.entries), seal(CTX.comment, i.comment), i.standing, i.visibility, i.source, i.source_ref, i.source_date, (prev?.version ?? 0) + 1, prev?.id ?? null, actor, i.idempotency_key ?? null])).rows[0];
  await audit(c, actor, 'record_academic_snapshot', 'academy_academic_snapshots', r.id);
  return r;
}

/** Decrypt a snapshot for a reader who is allowed to see grades. Every decryption is audit-logged (once per snapshot read). */
export async function snapshotView(c, s, reader, { full }) {
  const base = { id: s.id, term_label: s.term_label, version: s.version, period_from: s.period_from, period_to: s.period_to, source: s.source, source_label: SOURCE_LABEL[s.source], source_ref: s.source_ref, source_date: s.source_date, visibility: s.visibility, recorded_at: s.created_at, framework: { key: s.framework_snapshot.key, version: s.framework_snapshot.version, name: s.framework_snapshot.name, kind: s.framework_snapshot.kind, pass_mark: s.framework_snapshot.pass_mark } };
  if (!full) return { ...base, restricted: true };
  await audit(c, reader, 'read_pii', 'academy_academic_snapshots', s.id);
  return { ...base, restricted: false, standing: s.standing, entries: open(CTX.entries, s.entries_enc, true), comment: open(CTX.comment, s.comment_enc) };
}

/** Rows a partner or bulk import may carry. Each is validated by the same rules as the single-record capabilities. */
export const importRow = z.discriminatedUnion('type', [
  z.object({ type: z.literal('block'), link_id: z.string().uuid().optional(), student_ref: z.string().trim().min(1).max(60).optional(), block: blockInput }),
  z.object({ type: z.literal('attendance'), link_id: z.string().uuid().optional(), student_ref: z.string().trim().min(1).max(60).optional(), attendance: attendanceInput }),
  z.object({ type: z.literal('snapshot'), link_id: z.string().uuid().optional(), student_ref: z.string().trim().min(1).max(60).optional(), snapshot: snapshotInput }),
]);

/**
 * Apply rows atomically (the caller's transaction rolls back on any error) or only validate them (`dry`). Returns a result per row.
 * `links` are the candidate links the caller may touch; `canRecords` says whether snapshots are allowed for this channel.
 */
export async function applyRows(c, rows, { links, actor, channel, canRecords, dry, sourceFor }) {
  const byId = new Map(links.map((l) => [l.id, l]));
  const byRef = new Map();
  for (const l of links) { const r = open(CTX.ref, l.student_ref_enc); if (r) byRef.set(r.toLowerCase(), l); }
  const results = [];
  for (const [n, row] of rows.entries()) {
    const out = { row: n + 1, type: row.type, ok: false };
    try {
      const link = row.link_id ? byId.get(row.link_id) : row.student_ref ? byRef.get(row.student_ref.toLowerCase()) : null;
      if (!link) throw notFound('Student');
      out.link_id = link.id;
      if (row.type === 'snapshot' && !canRecords) throw forbidden('Attainment records need the academic_records grant');
      const forced = (i) => ({ ...i, source: sourceFor(row.type, i.source) });
      await c.query('SAVEPOINT import_row');
      try {
        if (row.type === 'block') await insertBlock(c, link, forced(row.block), { actor });
        else if (row.type === 'attendance') await insertAttendance(c, link, forced(row.attendance), { actor });
        else await insertSnapshot(c, link, forced(row.snapshot), { actor });
        if (dry) await c.query('ROLLBACK TO SAVEPOINT import_row');
        await c.query('RELEASE SAVEPOINT import_row');
      } catch (e) { await c.query('ROLLBACK TO SAVEPOINT import_row'); await c.query('RELEASE SAVEPOINT import_row'); throw e; }
      out.ok = true;
    } catch (e) { out.error = e.message; out.code = e.code ?? 'invalid'; }
    results.push(out);
  }
  return results;
}
