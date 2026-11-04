// Academy academics & school integration (#783), part 1: verified school links, consent, the school timetable, sport-study clashes, settings, the desk and
// the athlete / guardian view. One definition -> REST + OpenAPI + MCP. Records and coordination are in academy-academics-records.js. Rules: src/academy-academics.js.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { orgFor } from '../org-access.js';
import { opsAccess, sessionFor } from '../academy-ops.js';
import { actFor } from '../academy.js';
import { guardiansOf, isYouth, hasConsent, requireGuardian } from '../youth.js';
import { academicClashes, settingsFor, KIND_LABEL } from '../academy-clashes.js';
import { academicsAccess, linkFor, eligibleSchool, insertBlock, blockInput, blockView, occurrences, day, PROVISIONS, SOURCE_LABEL, seal, open, CTX, currentAttendance, pctOf, exceptionOf } from '../academy-academics.js';
import { markAttendance } from './academy-attendance.js';

const TAG = 'Academy academics';
const SHARES = ['schedule', 'progress'];

/** Per-athlete consent state for a set of athletes in an academy: live share rows combined with the guardian's academic consent. */
async function shareMap(c, orgId, athleteIds) {
  const map = new Map(athleteIds.map((a) => [a, { schedule: false, progress: false, consent: true }]));
  if (!athleteIds.length) return map;
  const rows = (await c.query('SELECT athlete_id, level FROM academy_academic_shares WHERE organisation_id=$1 AND athlete_id = ANY($2::uuid[]) AND revoked_at IS NULL', [orgId, athleteIds])).rows;
  for (const r of rows) map.get(r.athlete_id)[r.level] = true;
  for (const a of athleteIds) { const m = map.get(a); if (m.schedule || m.progress) { m.consent = await hasConsent(a, 'academic', c); if (!m.consent) { m.schedule = false; m.progress = false; } } }
  return map;
}

const linkRow = (l, extra = {}) => ({
  id: l.id, enrolment_id: l.enrolment_id, athlete_id: l.athlete_id, athlete_name: l.athlete_name, school: { id: l.school_org_id, name: l.school_name, kind: l.school_kind, city: l.school_city },
  provision: l.provision, year_group: l.year_group, liaison_user_id: l.liaison_user_id, liaison_name: l.liaison_name ?? null, import_authorised: l.import_authorised, starts_on: l.starts_on, ends_on: l.ends_on, status: l.status, end_reason: l.end_reason, row_version: l.row_version, ...extra,
});
const LINK_SQL = `SELECT l.*, o.name AS school_name, o.kind AS school_kind, o.city AS school_city, u.display_name AS athlete_name, lu.display_name AS liaison_name, k.name AS cohort_name, p.title AS programme_title
  FROM academy_school_links l JOIN organisations o ON o.id=l.school_org_id JOIN users u ON u.id=l.athlete_id LEFT JOIN users lu ON lu.id=l.liaison_user_id
  JOIN org_enrolments e ON e.id=l.enrolment_id JOIN org_cohorts k ON k.id=e.cohort_id LEFT JOIN academy_programmes p ON p.id=k.programme_id`;

// ------------------------------------------------------------------ schools and links
cap({
  name: 'search_academy_schools', method: 'GET', path: '/organisations/:id/academy/schools', tag: TAG,
  summary: 'Find a verified school, college or university to link: active organisations of those kinds that the platform team has approved. Returns the canonical organisation (id, name, kind, city); nothing is copied into the academy. Needs academics access.',
  input: z.object({ id, q: z.string().trim().max(80).optional(), ...page }),
  async handler({ user }, i) {
    await academicsAccess(user, i.id);
    const rows = await many(
      `SELECT o.id, o.name, o.kind, o.city, (SELECT count(*)::int FROM academy_school_links l WHERE l.school_org_id=o.id AND l.organisation_id=$1 AND l.status='active') AS linked_here
         FROM organisations o WHERE o.kind IN ('school','college','university') AND o.status='active' AND o.approval_status='approved' AND o.id<>$1 AND ($2::text IS NULL OR o.name ILIKE '%' || $2 || '%')
        ORDER BY (SELECT count(*) FROM academy_school_links l WHERE l.school_org_id=o.id AND l.organisation_id=$1 AND l.status='active') DESC, o.name, o.id LIMIT $3 OFFSET $4`, [i.id, i.q ?? null, i.limit, i.offset]);
    return { schools: rows, verified_note: 'Only schools the platform team has approved can be linked.' };
  },
});

cap({
  name: 'list_academy_school_candidates', method: 'GET', path: '/organisations/:id/academy/school-links/candidates', tag: TAG,
  summary: 'Enrolled athletes who can be linked to a school: one row per live enrolment with its programme and group, and how many schools are already linked. Names only. Needs academics access.',
  input: z.object({ id, q: z.string().trim().max(80).optional(), ...page }),
  async handler({ user }, i) {
    await academicsAccess(user, i.id);
    return many(
      `SELECT e.id AS enrolment_id, u.id AS athlete_id, u.display_name, p.title AS programme, k.name AS cohort,
              (SELECT count(*)::int FROM academy_school_links l WHERE l.enrolment_id=e.id AND l.status='active') AS linked_schools
         FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id JOIN users u ON u.id=e.user_id LEFT JOIN academy_programmes p ON p.id=k.programme_id
        WHERE k.organisation_id=$1 AND e.status='enrolled' AND ($2::text IS NULL OR u.display_name ILIKE '%' || $2 || '%') ORDER BY u.display_name, e.id LIMIT $3 OFFSET $4`, [i.id, i.q ?? null, i.limit, i.offset]);
  },
});

cap({
  name: 'link_academy_school', method: 'POST', path: '/academy/enrolments/:id/school-links', tag: TAG, status: 201,
  summary: 'Link an enrolled athlete to a verified school (the canonical organisation, referenced by id). Creates no school record and shares nothing: the athlete or a verified guardian must still allow the academy to hold school timetable / progress. The family is told in generic wording. One live link per enrolment and school; idempotent per idempotency_key.',
  input: z.object({ id, school_org_id: id, provision: z.enum(PROVISIONS).default('partner_school'), year_group: z.string().trim().max(30).optional(), student_ref: z.string().trim().max(60).optional(),
    liaison_user_id: id.optional(), import_authorised: z.boolean().default(false), starts_on: day.optional(), idempotency_key: z.string().min(8).max(80) }),
  handler: ({ user }, i) => tx(async (c) => {
    const e = (await c.query('SELECT e.*, k.organisation_id FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE e.id=$1', [i.id])).rows[0];
    if (!e) throw notFound('Enrolment');
    await academicsAccess(user, e.organisation_id, { write: true, c });
    if (e.status !== 'enrolled') throw conflict('Only an enrolled athlete can be linked to a school');
    await eligibleSchool(c, i.school_org_id, e.organisation_id);
    if (i.liaison_user_id && !(await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [i.school_org_id, i.liaison_user_id])).rowCount) throw badRequest('The school liaison must be an active member of that school');
    const live = (await c.query("SELECT id FROM academy_school_links WHERE enrolment_id=$1 AND school_org_id=$2 AND status='active'", [e.id, i.school_org_id])).rows[0];
    if (live) { if (live.created_by === user.id) return linkRow((await c.query(`${LINK_SQL} WHERE l.id=$1`, [live.id])).rows[0], { replayed: true }); throw conflict('This athlete is already linked to that school'); }
    const r = (await c.query(
      `INSERT INTO academy_school_links(organisation_id, enrolment_id, athlete_id, school_org_id, provision, year_group, student_ref_enc, liaison_user_id, import_authorised, starts_on, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10::date, current_date),$11) RETURNING id`,
      [e.organisation_id, e.id, e.user_id, i.school_org_id, i.provision, i.year_group ?? null, seal(CTX.ref, i.student_ref), i.liaison_user_id ?? null, i.import_authorised, i.starts_on ?? null, user.id])).rows[0];
    await audit(c, user.id, 'link_academy_school', 'academy_school_links', r.id);
    const who = (await isYouth(e.user_id, c)) ? await guardiansOf(e.user_id, c) : [e.user_id];
    for (const to of who) await notify(c, to, { kind: 'academy_school_linked', title: 'Your academy linked a school', body: 'Open Gotmygame to choose what school information the academy may hold.', data: { organisation_id: e.organisation_id, athlete_id: e.user_id }, dedupe_key: `academy:school:${r.id}:${to}` });
    return linkRow((await c.query(`${LINK_SQL} WHERE l.id=$1`, [r.id])).rows[0]);
  }),
});

cap({
  name: 'update_academy_school_link', method: 'PATCH', path: '/academy/school-links/:id', tag: TAG,
  summary: 'Edit a school link (year group, school reference, liaison, whether the school may submit records) or end it with a reason. Ending keeps every record already held; nothing is deleted. Optimistic concurrency by row_version.',
  input: z.object({ id, row_version: z.number().int().min(1), year_group: z.string().trim().max(30).nullable().optional(), student_ref: z.string().trim().max(60).nullable().optional(), provision: z.enum(PROVISIONS).optional(),
    liaison_user_id: id.nullable().optional(), import_authorised: z.boolean().optional(), end: z.object({ reason: z.string().trim().min(3).max(200), ends_on: day.optional() }).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { link } = await linkFor(user, i.id, { write: true, c });
    if (link.row_version !== i.row_version) throw conflict('This link changed since you opened it', { code: 'stale', current_row_version: link.row_version });
    if (link.status === 'ended') throw conflict('This link has ended');
    if (i.liaison_user_id && !(await c.query("SELECT 1 FROM organisation_members WHERE organisation_id=$1 AND user_id=$2 AND status='active'", [link.school_org_id, i.liaison_user_id])).rowCount) throw badRequest('The school liaison must be an active member of that school');
    const has = (k) => i[k] !== undefined;
    await c.query(
      `UPDATE academy_school_links SET year_group=CASE WHEN $2::boolean THEN $3 ELSE year_group END, student_ref_enc=CASE WHEN $4::boolean THEN $5 ELSE student_ref_enc END, provision=coalesce($6,provision),
              liaison_user_id=CASE WHEN $7::boolean THEN $8 ELSE liaison_user_id END, import_authorised=coalesce($9,import_authorised),
              status=CASE WHEN $10::text IS NOT NULL THEN 'ended' ELSE status END, end_reason=coalesce($10, end_reason), ends_on=CASE WHEN $10::text IS NOT NULL THEN coalesce($11::date, current_date) ELSE ends_on END,
              row_version=row_version+1, updated_at=now() WHERE id=$1`,
      [link.id, has('year_group'), i.year_group ?? null, has('student_ref'), seal(CTX.ref, i.student_ref), i.provision ?? null, has('liaison_user_id'), i.liaison_user_id ?? null, i.import_authorised ?? null, i.end?.reason ?? null, i.end?.ends_on ?? null]);
    await audit(c, user.id, i.end ? 'end_academy_school_link' : 'update_academy_school_link', 'academy_school_links', link.id);
    return linkRow((await c.query(`${LINK_SQL} WHERE l.id=$1`, [link.id])).rows[0]);
  }),
});

cap({
  name: 'list_academy_school_links', method: 'GET', path: '/organisations/:id/academy/school-links', tag: TAG,
  summary: 'The academy\'s school links with what is shared: for each athlete the school, year group, whether the athlete / guardian allowed timetable and progress, the next school exam and latest school attendance (only when timetable is shared). No grades. Filter by status, school or athlete name. Needs academics access.',
  input: z.object({ id, status: z.enum(['active', 'ended']).default('active'), school_org_id: id.optional(), q: z.string().trim().max(80).optional(), ...page }),
  async handler({ user }, i) {
    const a = await academicsAccess(user, i.id);
    const rows = await many(`${LINK_SQL} WHERE l.organisation_id=$1 AND l.status=$2 AND ($3::uuid IS NULL OR l.school_org_id=$3) AND ($4::text IS NULL OR u.display_name ILIKE '%' || $4 || '%') ORDER BY u.display_name, l.id LIMIT $5 OFFSET $6`, [i.id, i.status, i.school_org_id ?? null, i.q ?? null, i.limit, i.offset]);
    const total = (await one(`SELECT count(*)::int AS n FROM academy_school_links l JOIN users u ON u.id=l.athlete_id WHERE l.organisation_id=$1 AND l.status=$2 AND ($3::uuid IS NULL OR l.school_org_id=$3) AND ($4::text IS NULL OR u.display_name ILIKE '%' || $4 || '%')`, [i.id, i.status, i.school_org_id ?? null, i.q ?? null])).n;
    const shares = await shareMap(pool, i.id, [...new Set(rows.map((r) => r.athlete_id))]);
    const out = [];
    for (const l of rows) {
      const s = shares.get(l.athlete_id);
      const extra = { cohort: l.cohort_name, programme: l.programme_title, shared: { schedule: s.schedule, progress: s.progress, consent: s.consent } };
      if (s.schedule) {
        extra.next_exam = (await one("SELECT min(starts_at) AS at FROM academy_school_blocks WHERE link_id=$1 AND status='active' AND kind='exam' AND recurrence='once' AND starts_at > now()", [l.id]))?.at ?? null;
        const att = (await currentAttendance(pool, l.id))[0];
        extra.attendance = att ? { percent: pctOf(att), period_from: att.period_from, period_to: att.period_to, source: att.source, source_label: SOURCE_LABEL[att.source] } : null;
      }
      out.push(linkRow(l, extra));
    }
    return { links: out, total, permissions: { academics: true, academic_records: a.records } };
  },
});

// ------------------------------------------------------------------ the school timetable
cap({
  name: 'save_academy_school_block', method: 'POST', path: '/academy/school-links/:id/blocks', tag: TAG, status: 201,
  summary: 'Record a school day, lesson, exam, tutoring or study block for a linked athlete: one-off (starts_at / ends_at) or weekly (weekday, times, term dates, skipped holidays) in the block\'s own time zone. Needs the athlete / guardian to have allowed the academy to hold the school timetable. Every block carries its source (school confirmed, entered and verified by the academy, imported) and reference. The subject label is encrypted and visible to academic_records staff only.',
  input: z.object({ id }).merge(blockInput),
  handler: ({ user }, { id: linkId, ...b }) => tx(async (c) => {
    const { link } = await linkFor(user, linkId, { write: true, c });
    const row = await insertBlock(c, link, b, { actor: user.id });
    // a new exam or lesson can clash with sessions that are already published: raise one coordination task per clash, once
    const upcoming = (await c.query("SELECT s.* FROM academy_sessions s JOIN org_enrolments e ON e.cohort_id=s.cohort_id AND e.user_id=$2 AND e.status='enrolled' WHERE s.organisation_id=$1 AND s.status='published' AND s.starts_at > now() AND s.starts_at < now() + interval '60 days' ORDER BY s.starts_at LIMIT 200", [link.organisation_id, link.athlete_id])).rows;
    let raised = 0;
    for (const s of upcoming) {
      const found = await academicClashes(c, s);
      for (const x of found.clashes.filter((y) => y.block_id === row.id)) {
        raised += (await c.query(
          `INSERT INTO academy_academic_tasks(organisation_id, athlete_id, link_id, kind, audience, title, priority, due_on, source_type, source_id, created_by)
           VALUES ($1,$2,$3,'exam_clash','coach',$4,'high',($5::timestamptz)::date,'school_clash',$6,$7) ON CONFLICT DO NOTHING`,
          [link.organisation_id, link.athlete_id, link.id, `A published session clashes with a ${KIND_LABEL[x.block_kind]}`, s.starts_at, `${s.id}:${x.athlete_id}:${x.block_id}`, user.id])).rowCount;
      }
    }
    return { ...blockView(row, false), clashes_with_published_sessions: raised };
  }),
});

cap({
  name: 'cancel_academy_school_block', method: 'POST', path: '/academy/school-blocks/:id/cancel', tag: TAG,
  summary: 'Cancel a school block (it stays on record, marked cancelled, and stops causing clashes). Needs academics access.',
  input: z.object({ id, reason: z.string().trim().min(3).max(200) }),
  handler: ({ user }, i) => tx(async (c) => {
    const b = (await c.query('SELECT * FROM academy_school_blocks WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!b) throw notFound('School block');
    await academicsAccess(user, b.organisation_id, { write: true, c });
    if (b.status === 'cancelled') return blockView(b, false);
    const r = (await c.query("UPDATE academy_school_blocks SET status='cancelled', cancel_reason=$2, row_version=row_version+1, updated_at=now() WHERE id=$1 RETURNING *", [b.id, i.reason])).rows[0];
    await audit(c, user.id, 'cancel_school_block', 'academy_school_blocks', b.id);
    return blockView(r, false);
  }),
});

cap({
  name: 'list_academy_school_blocks', method: 'GET', path: '/organisations/:id/academy/school-blocks', tag: TAG,
  summary: 'School commitments as dated occurrences in a window (at most 92 days): weekly blocks are expanded for their term in their own time zone, skipping holidays. Only athletes whose timetable is shared appear. Subject labels appear only for academic_records staff. Needs academics access.',
  input: z.object({ id, from: day, to: day, athlete_id: id.optional(), kind: z.enum(['school_day', 'lesson', 'exam', 'tutoring', 'study_hall', 'school_event']).optional() }),
  async handler({ user }, i) {
    const a = await academicsAccess(user, i.id);
    if (i.to < i.from || (new Date(i.to) - new Date(i.from)) / 86400000 > 92) throw badRequest('Choose a window of at most 92 days');
    const rows = await many(
      `SELECT b.*, u.display_name FROM academy_school_blocks b JOIN academy_school_links l ON l.id=b.link_id AND l.status='active' JOIN users u ON u.id=b.athlete_id
        WHERE b.organisation_id=$1 AND b.status='active' AND ($2::uuid IS NULL OR b.athlete_id=$2) AND ($3::text IS NULL OR b.kind=$3)
          AND EXISTS (SELECT 1 FROM academy_academic_shares sh WHERE sh.organisation_id=b.organisation_id AND sh.athlete_id=b.athlete_id AND sh.level='schedule' AND sh.revoked_at IS NULL)
        ORDER BY u.display_name, b.id LIMIT 2000`, [i.id, i.athlete_id ?? null, i.kind ?? null]);
    const shares = await shareMap(pool, i.id, [...new Set(rows.map((r) => r.athlete_id))]);
    const items = [];
    for (const b of rows) {
      if (!shares.get(b.athlete_id).schedule) continue;
      for (const o of occurrences(b, i.from, i.to)) items.push({ ...o, athlete_id: b.athlete_id, athlete_name: b.display_name, link_id: b.link_id, source: b.source, source_label: SOURCE_LABEL[b.source], source_ref: b.source_ref, label: a.records ? open(CTX.label, b.label_enc) : undefined });
    }
    items.sort((x, y) => x.starts_at.localeCompare(y.starts_at) || x.athlete_name.localeCompare(y.athlete_name));
    return { items: items.slice(0, 1500), truncated: items.length > 1500 };
  },
});

// ------------------------------------------------------------------ clashes
cap({
  name: 'check_academy_academic_clashes', method: 'GET', path: '/organisations/:id/academy/academics/clashes', tag: TAG,
  summary: 'Sport-study clashes before the schedule is published: every draft and published academy session in the window, with the athletes whose school exam, lesson or school day overlaps it (hard clashes), tutoring / study overlaps and exams\' rest buffers (warnings), and the ones already resolved by excusing the athlete. Names and the kind of commitment only; subjects are never returned. Needs schedule or academics access.',
  input: z.object({ id, from: day, to: day, status: z.enum(['draft', 'published', 'both']).default('both') }),
  async handler({ user }, i) {
    const a = await opsAccess(user, i.id);
    if (!a.hasBroad('schedule') && !a.hasBroad('academics')) throw forbidden('You do not have schedule or academics access to this academy');
    if (i.to < i.from || (new Date(i.to) - new Date(i.from)) / 86400000 > 92) throw badRequest('Choose a window of at most 92 days');
    const sessions = await many("SELECT s.*, k.name AS cohort_name FROM academy_sessions s JOIN org_cohorts k ON k.id=s.cohort_id WHERE s.organisation_id=$1 AND s.status = ANY($2) AND s.starts_at >= $3::date AND s.starts_at < $4::date + 1 ORDER BY s.starts_at, s.id LIMIT 400", [i.id, i.status === 'both' ? ['draft', 'published'] : [i.status], i.from, i.to]);
    const out = [];
    for (const s of sessions) {
      const r = await academicClashes(pool, s);
      if (r.clashes.length || r.warnings.length || r.resolved.length) out.push({ session_id: s.id, title: s.title, cohort_name: s.cohort_name, status: s.status, starts_at: s.starts_at, ends_at: s.ends_at, ...r });
    }
    return { sessions: out, checked: sessions.length, open_clashes: out.reduce((n, s) => n + s.clashes.length, 0), warnings: out.reduce((n, s) => n + s.warnings.length, 0) };
  },
});

cap({
  name: 'resolve_academy_academic_clash', method: 'POST', path: '/academy/sessions/:id/academic-clashes', tag: TAG,
  summary: 'Resolve one athlete\'s clash with a session by excusing them for school (school comes first). The decision is recorded with who and why and cannot be edited; once the session is published the athlete is marked excused (reason: school) on the roster. To remove the clash itself, move the session or the school block instead. Needs schedule access.',
  input: z.object({ id, athlete_id: id, block_id: id, note: z.string().trim().max(200).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const { s } = await sessionFor(user, i.id, 'schedule', { write: true, c });
    const found = await academicClashes(c, s);
    const hit = [...found.clashes, ...found.warnings, ...found.resolved].find((x) => x.athlete_id === i.athlete_id && x.block_id === i.block_id);
    if (!hit) throw notFound('Clash');
    const r = await c.query("INSERT INTO academy_clash_resolutions(organisation_id, session_id, athlete_id, block_id, note, resolved_by) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (session_id, athlete_id, block_id) DO NOTHING", [s.organisation_id, s.id, i.athlete_id, i.block_id, i.note ?? null, user.id]);
    if (r.rowCount) await audit(c, user.id, 'resolve_academic_clash', 'academy_sessions', s.id);
    if (s.status === 'published') { try { await markAttendance(c, s, i.athlete_id, 'excused', { source: 'system', actor: user.id, reason_code: 'school' }); } catch (e) { if (!e.status || e.status >= 500) throw e; } }
    return { session_id: s.id, athlete_id: i.athlete_id, block_id: i.block_id, resolution: 'excused', already: !r.rowCount };
  }),
});

// ------------------------------------------------------------------ settings
cap({
  name: 'set_academy_academic_settings', method: 'PATCH', path: '/organisations/:id/academy/academics/settings', tag: TAG,
  summary: 'Owner/admin: the academy\'s own academic rules — the school-attendance threshold and unauthorised-absence limit that raise a follow-up task, the rest buffer around exams, and how often a progress snapshot is due. Defaults are a starting point, not a statement of any jurisdiction\'s requirements.',
  input: z.object({ id, attendance_threshold_pct: z.number().int().min(50).max(100).optional(), unauthorised_limit: z.number().int().min(0).max(60).optional(), exam_buffer_min: z.number().int().min(0).max(720).optional(), snapshot_cadence_days: z.number().int().min(7).max(400).optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    await orgFor(user, i.id, ['owner', 'admin'], { write: true, c });
    const cur = await settingsFor(c, i.id);
    const n = { ...cur, ...Object.fromEntries(Object.entries(i).filter(([k, v]) => k !== 'id' && v !== undefined)) };
    const r = (await c.query(
      `INSERT INTO academy_academic_settings(organisation_id, attendance_threshold_pct, unauthorised_limit, exam_buffer_min, snapshot_cadence_days, updated_by) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (organisation_id) DO UPDATE SET attendance_threshold_pct=EXCLUDED.attendance_threshold_pct, unauthorised_limit=EXCLUDED.unauthorised_limit, exam_buffer_min=EXCLUDED.exam_buffer_min, snapshot_cadence_days=EXCLUDED.snapshot_cadence_days, updated_by=EXCLUDED.updated_by, updated_at=now() RETURNING *`,
      [i.id, n.attendance_threshold_pct, n.unauthorised_limit, n.exam_buffer_min, n.snapshot_cadence_days, user.id])).rows[0];
    await audit(c, user.id, 'set_academic_settings', 'organisations', i.id);
    return r;
  }),
});

// ------------------------------------------------------------------ the desk
cap({
  name: 'get_academy_academics', method: 'GET', path: '/organisations/:id/academy/academics', tag: TAG,
  summary: 'The Academics desk: key figures (athletes linked to a school, consent coverage, exams in the next 14 days, open sport-study clashes in the next 30 days, school-attendance exceptions, progress snapshots due, open and overdue tasks), the schools involved, the next exams, exceptions and clashes. Only athletes whose timetable is shared are read; consent still pending is counted, never inferred. Grades are never part of this view. Needs academics access.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const a = await academicsAccess(user, i.id);
    const settings = await settingsFor(pool, i.id);
    const enrolled = (await one("SELECT count(DISTINCT e.user_id)::int AS n FROM org_enrolments e JOIN org_cohorts k ON k.id=e.cohort_id WHERE k.organisation_id=$1 AND e.status='enrolled'", [i.id])).n;
    const links = await many(`${LINK_SQL} WHERE l.organisation_id=$1 AND l.status='active' ORDER BY u.display_name, l.id LIMIT 1000`, [i.id]);
    const shares = await shareMap(pool, i.id, [...new Set(links.map((l) => l.athlete_id))]);
    const shared = links.filter((l) => shares.get(l.athlete_id).schedule);
    const bySchool = new Map();
    for (const l of links) { const s = bySchool.get(l.school_org_id) ?? { school_id: l.school_org_id, name: l.school_name, kind: l.school_kind, athletes: 0, shared: 0 }; s.athletes++; if (shares.get(l.athlete_id).schedule) s.shared++; bySchool.set(l.school_org_id, s); }
    const exams = shared.length ? await many(
      `SELECT b.id, b.link_id, b.athlete_id, u.display_name, b.starts_at, b.ends_at, b.source, b.source_ref FROM academy_school_blocks b JOIN users u ON u.id=b.athlete_id
        WHERE b.link_id = ANY($1::uuid[]) AND b.status='active' AND b.kind='exam' AND b.starts_at > now() AND b.starts_at < now() + interval '14 days' ORDER BY b.starts_at, b.id LIMIT 25`, [shared.map((l) => l.id)]) : [];
    const exceptions = [];
    for (const l of shared) {
      const cur = (await currentAttendance(pool, l.id))[0];
      if (!cur) continue;
      const reasons = exceptionOf(cur, settings);
      if (reasons.length) exceptions.push({ link_id: l.id, athlete_id: l.athlete_id, athlete_name: l.athlete_name, school: l.school_name, percent: pctOf(cur), unauthorised: cur.unauthorised_absence, period_from: cur.period_from, period_to: cur.period_to, source_label: SOURCE_LABEL[cur.source], reasons });
    }
    const sessions = await many("SELECT s.*, k.name AS cohort_name FROM academy_sessions s JOIN org_cohorts k ON k.id=s.cohort_id WHERE s.organisation_id=$1 AND s.status IN ('draft','published') AND s.starts_at > now() AND s.starts_at < now() + interval '30 days' ORDER BY s.starts_at, s.id LIMIT 300", [i.id]);
    const clashes = [];
    if (shared.length) for (const s of sessions) { const r = await academicClashes(pool, s); for (const x of r.clashes) clashes.push({ session_id: s.id, title: s.title, cohort_name: s.cohort_name, status: s.status, starts_at: s.starts_at, athlete_id: x.athlete_id, athlete_name: x.display_name, block_kind: x.block_kind, message: x.message, block_id: x.block_id }); }
    const withProgress = links.filter((l) => shares.get(l.athlete_id).progress);
    const due = [];
    for (const l of withProgress) {
      const last = (await one('SELECT max(created_at) AS at FROM academy_academic_snapshots WHERE link_id=$1', [l.id]))?.at;
      const days = last ? Math.floor((Date.now() - new Date(last)) / 86400000) : null;
      if (days == null || days >= settings.snapshot_cadence_days) due.push({ link_id: l.id, athlete_id: l.athlete_id, athlete_name: l.athlete_name, school: l.school_name, last_snapshot_days: days });
    }
    const tasks = await one("SELECT count(*) FILTER (WHERE status IN ('open','in_progress'))::int AS open, count(*) FILTER (WHERE status IN ('open','in_progress') AND due_on < current_date)::int AS overdue FROM academy_academic_tasks WHERE organisation_id=$1", [i.id]);
    return {
      my_access: { academics: true, academic_records: a.records, schedule: a.has('schedule'), owner_admin: a.admin }, settings,
      kpis: { enrolled, linked: links.length, coverage_pct: enrolled ? Math.round((new Set(links.map((l) => l.athlete_id)).size / enrolled) * 100) : null, schedule_shared: shared.length, progress_shared: withProgress.length, consent_pending: links.filter((l) => !shares.get(l.athlete_id).schedule).length,
        exams_14d: exams.length, open_clashes: clashes.length, attendance_exceptions: exceptions.length, snapshots_due: a.records ? due.length : null, tasks_open: tasks.open, tasks_overdue: tasks.overdue },
      schools: [...bySchool.values()].sort((x, y) => y.athletes - x.athletes || x.name.localeCompare(y.name)), exams: exams.map((e) => ({ ...e, athlete_name: e.display_name })), exceptions, clashes: clashes.slice(0, 40),
      snapshots_due: a.records ? due.slice(0, 40) : [], sources: SOURCE_LABEL,
    };
  },
});

// ------------------------------------------------------------------ the athlete / guardian side
const mineFor = async (user, childId, c) => {
  const athleteId = childId ?? user.id;
  if (athleteId !== user.id) await requireGuardian(user, athleteId, c, 'consent');
  return athleteId;
};

cap({
  name: 'get_my_academy_academics', method: 'GET', path: '/me/academy/academics', tag: TAG,
  summary: 'The athlete\'s (or a verified guardian\'s, with child_id) school and study view across their academies: each linked school, what the academy is allowed to hold (timetable, progress), the next two weeks of school next to the sport timetable (kept apart, each with its source), exams, school attendance summaries, and the progress snapshots the academy marked visible to the family. Grades are shown only to the athlete / guardian and every read is audit-logged.',
  input: z.object({ child_id: id.optional(), days: z.coerce.number().int().min(1).max(60).default(14) }),
  async handler({ user }, i) {
    const athleteId = await mineFor(user, i.child_id, pool);
    const links = await many(`${LINK_SQL} WHERE l.athlete_id=$1 ORDER BY l.status, o.name, l.id`, [athleteId]);
    const from = new Date().toISOString().slice(0, 10), to = new Date(Date.now() + i.days * 86400000).toISOString().slice(0, 10);
    const out = [];
    for (const l of links) {
      const s = (await shareMap(pool, l.organisation_id, [athleteId])).get(athleteId);
      const academy = await one('SELECT id, name FROM organisations WHERE id=$1', [l.organisation_id]);
      const row = { ...linkRow(l), academy, shared: { schedule: s.schedule, progress: s.progress, consent: s.consent }, school_timetable: [], sport_timetable: [], attendance: [], snapshots: [], clashes: [] };
      if (l.status === 'active') {
        row.sport_timetable = (await many("SELECT s.id, s.title, s.starts_at, s.ends_at, s.delivery_type FROM academy_sessions s JOIN org_enrolments e ON e.cohort_id=s.cohort_id AND e.user_id=$1 AND e.status='enrolled' WHERE s.organisation_id=$2 AND s.status='published' AND s.starts_at >= now() AND s.starts_at < $3::date + 1 ORDER BY s.starts_at LIMIT 100", [athleteId, l.organisation_id, to])).map((x) => ({ ...x, source_label: 'Academy timetable' }));
      }
      if (s.schedule) {
        const blocks = await many("SELECT * FROM academy_school_blocks WHERE link_id=$1 AND status='active'", [l.id]);
        for (const b of blocks) for (const o of occurrences(b, from, to)) row.school_timetable.push({ ...o, label: open(CTX.label, b.label_enc), source: b.source, source_label: SOURCE_LABEL[b.source], source_ref: b.source_ref });
        row.school_timetable.sort((x, y) => x.starts_at.localeCompare(y.starts_at));
        row.attendance = (await currentAttendance(pool, l.id)).slice(0, 6).map((r) => ({ period_from: r.period_from, period_to: r.period_to, percent: pctOf(r), present: r.present, sessions_possible: r.sessions_possible, authorised_absence: r.authorised_absence, unauthorised_absence: r.unauthorised_absence, late: r.late, source: r.source, source_label: SOURCE_LABEL[r.source], source_ref: r.source_ref }));
        const sess = await many('SELECT s.* FROM academy_sessions s WHERE s.id = ANY($1::uuid[])', [row.sport_timetable.map((x) => x.id)]);
        for (const x of sess) for (const y of (await academicClashes(pool, x)).clashes.concat((await academicClashes(pool, x)).warnings).filter((z) => z.athlete_id === athleteId)) row.clashes.push({ session_id: x.id, title: x.title, starts_at: x.starts_at, kind: y.block_kind, message: y.message });
      }
      if (s.progress) {
        // the latest version of each term, and only if that version is marked visible to the family (a staff-only correction never leaves a superseded grade on show)
        const snaps = await many("SELECT * FROM (SELECT DISTINCT ON (lower(term_label)) * FROM academy_academic_snapshots WHERE link_id=$1 ORDER BY lower(term_label), version DESC) x WHERE visibility='athlete_guardian'", [l.id]);
        for (const sn of snaps.sort((x, y) => String(y.period_to).localeCompare(String(x.period_to)))) {
          await audit(null, user.id, 'read_pii', 'academy_academic_snapshots', sn.id);
          row.snapshots.push({ id: sn.id, term_label: sn.term_label, version: sn.version, period_from: sn.period_from, period_to: sn.period_to, standing: sn.standing, entries: open(CTX.entries, sn.entries_enc, true), comment: open(CTX.comment, sn.comment_enc), source: sn.source, source_label: SOURCE_LABEL[sn.source], source_ref: sn.source_ref, source_date: sn.source_date, framework: { name: sn.framework_snapshot.name, kind: sn.framework_snapshot.kind } });
        }
      }
      out.push(row);
    }
    const youth = await isYouth(athleteId, pool);
    return { athlete_id: athleteId, is_youth: youth, academic_consent: youth ? await hasConsent(athleteId, 'academic', pool) : true, window: { from, to }, links: out,
      privacy: 'The academy only sees what you allow here. Grades are never shared with scouts, recruiters or sponsors through the academy.' };
  },
});

cap({
  name: 'set_academy_academic_share', method: 'POST', path: '/me/academy/academics/share', tag: TAG,
  summary: 'The athlete (adult) or a verified guardian (for a young person) allows or withdraws what an academy may hold: `schedule` = school timetable, exams and attendance summary; `progress` = attainment snapshots. Withdrawing hides the data from the academy at once; records already made are kept. For a young person the guardian\'s `academic` consent (grant_youth_consent) must also be current.',
  input: z.object({ organisation_id: id, athlete_id: id.optional(), level: z.enum(SHARES), enabled: z.boolean() }),
  handler: ({ user }, i) => tx(async (c) => {
    const athleteId = i.athlete_id ?? user.id;
    await actFor(user, athleteId, c);
    if (athleteId !== user.id) await requireGuardian(user, athleteId, c, 'consent');
    const linked = (await c.query("SELECT 1 FROM academy_school_links WHERE organisation_id=$1 AND athlete_id=$2 AND status='active'", [i.organisation_id, athleteId])).rowCount;
    if (!linked) throw notFound('School link');       // the family only ever sees academies that linked a school: existence is not leaked
    if (i.enabled) {
      if (!(await hasConsent(athleteId, 'academic', c))) throw conflict('A verified guardian has not given current consent for academic information. Allow it under Family & guardians first.', { code: 'guardian_consent_required', purpose: 'academic' });
      await c.query('INSERT INTO academy_academic_shares(organisation_id, athlete_id, level, granted_by) VALUES ($1,$2,$3,$4) ON CONFLICT (organisation_id, athlete_id, level) WHERE revoked_at IS NULL DO NOTHING', [i.organisation_id, athleteId, i.level, user.id]);
    } else {
      await c.query('UPDATE academy_academic_shares SET revoked_at=now(), revoked_by=$4 WHERE organisation_id=$1 AND athlete_id=$2 AND level=$3 AND revoked_at IS NULL', [i.organisation_id, athleteId, i.level, user.id]);
    }
    await audit(c, user.id, i.enabled ? 'allow_academic_share' : 'withdraw_academic_share', 'users', athleteId);
    return { organisation_id: i.organisation_id, athlete_id: athleteId, level: i.level, enabled: i.enabled };
  }),
});
