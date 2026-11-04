// Academy academics (#783): the sport-study clash engine and the consent gate it depends on. Pure reads over the canonical records (sessions, cohort
// enrolments, school blocks); it stores nothing. It is imported by the session publish check (academy-ops.js), so it must not import any capability.
//
// Who is looked at: athletes enrolled in the session's cohort whose guardian / own `schedule` share is live (and, for a young person, whose guardian's
// `academic` consent is current). Anyone else is invisible to this engine, so school information is never inferred without permission.
import { hasConsent } from './youth.js';

export const BLOCK_KINDS = ['school_day', 'lesson', 'exam', 'tutoring', 'study_hall', 'school_event'];
export const KIND_LABEL = { school_day: 'school day', lesson: 'lesson', exam: 'school exam', tutoring: 'tutoring', study_hall: 'study hall', school_event: 'school event' };
/** Which kinds refuse publication until resolved (the athlete must be somewhere else) and which only warn. */
export const HARD_KINDS = ['exam', 'lesson', 'school_day', 'school_event'];

/** Is this athlete's `level` share live for the academy, and (for a young person) has a verified guardian allowed academic information? */
export async function shareLive(c, orgId, athleteId, level) {
  const live = (await c.query('SELECT 1 FROM academy_academic_shares WHERE organisation_id=$1 AND athlete_id=$2 AND level=$3 AND revoked_at IS NULL', [orgId, athleteId, level])).rowCount > 0;
  return live && (await hasConsent(athleteId, 'academic', c));
}

/** Minutes-of-day and local-date maths run in SQL so the block's own time zone and its skipped dates apply exactly. */
const WEEKLY = (st, en) => `(b.recurrence='weekly'
  AND (${st} AT TIME ZONE b.timezone)::date = (${en} AT TIME ZONE b.timezone)::date
  AND EXTRACT(DOW FROM ${st} AT TIME ZONE b.timezone)::int = b.weekday
  AND (${st} AT TIME ZONE b.timezone)::date BETWEEN b.valid_from AND b.valid_to
  AND NOT ((${st} AT TIME ZONE b.timezone)::date = ANY(b.skip_dates)))`;
const MIN = (ts) => `(EXTRACT(HOUR FROM ${ts} AT TIME ZONE b.timezone)::int * 60 + EXTRACT(MINUTE FROM ${ts} AT TIME ZONE b.timezone)::int)`;
const BMIN = (col) => `(EXTRACT(HOUR FROM b.${col})::int * 60 + EXTRACT(MINUTE FROM b.${col})::int)`;

/**
 * School commitments that overlap [start, end) for the given athletes. `direct` = overlaps the block itself; `near` = an exam whose
 * buffer (before / after) the session intrudes on. Only active blocks of active links with a live schedule share are considered.
 */
export async function overlappingBlocks(c, orgId, athleteIds, start, end, bufferMin) {
  if (!athleteIds.length) return [];
  const { rows } = await c.query(
    `SELECT * FROM (
       SELECT b.id AS block_id, b.link_id, b.athlete_id, b.kind, b.recurrence, u.display_name,
              CASE WHEN b.recurrence='once' THEN (b.starts_at < $3::timestamptz AND b.ends_at > $2::timestamptz)
                   ELSE (${WEEKLY('$2::timestamptz', '$3::timestamptz')} AND ${MIN('$2::timestamptz')} < ${BMIN('end_time')} AND ${MIN('$3::timestamptz')} > ${BMIN('start_time')}) END AS direct,
              CASE WHEN b.kind <> 'exam' THEN false
                   WHEN b.recurrence='once' THEN (b.starts_at < $3::timestamptz + make_interval(mins => $5::int) AND b.ends_at > $2::timestamptz - make_interval(mins => $5::int))
                   ELSE (${WEEKLY('$2::timestamptz', '$3::timestamptz')} AND ${MIN('$2::timestamptz')} < ${BMIN('end_time')} + $5::int AND ${MIN('$3::timestamptz')} > ${BMIN('start_time')} - $5::int) END AS buffered
         FROM academy_school_blocks b
         JOIN academy_school_links l ON l.id=b.link_id AND l.status='active'
         JOIN users u ON u.id=b.athlete_id
        WHERE b.organisation_id=$1 AND b.status='active' AND b.athlete_id = ANY($4::uuid[])
          AND EXISTS (SELECT 1 FROM academy_academic_shares sh WHERE sh.organisation_id=b.organisation_id AND sh.athlete_id=b.athlete_id AND sh.level='schedule' AND sh.revoked_at IS NULL)) x
      WHERE direct OR buffered ORDER BY display_name, block_id`, [orgId, start, end, athleteIds, bufferMin]);
  return rows;
}

export const settingsFor = async (c, orgId) => (await c.query('SELECT * FROM academy_academic_settings WHERE organisation_id=$1', [orgId])).rows[0]
  ?? { organisation_id: orgId, attendance_threshold_pct: 90, unauthorised_limit: 3, exam_buffer_min: 60, snapshot_cadence_days: 120 };

/**
 * Sport-study clashes of one session. `clashes` refuse publication until each is resolved (the athlete is excused for school) or the school
 * block / session moves; `warnings` (tutoring, study hall, an exam's rest buffer) need the same acknowledgement as a staffing warning.
 * Subject names are never returned here: staff see the athlete and the kind of commitment only.
 */
export async function academicClashes(c, s) {
  const cohort = (await c.query("SELECT user_id FROM org_enrolments WHERE cohort_id=$1 AND status='enrolled'", [s.cohort_id])).rows.map((r) => r.user_id);
  const out = { clashes: [], warnings: [], resolved: [] };
  if (!cohort.length) return out;
  const { exam_buffer_min } = await settingsFor(c, s.organisation_id);
  const rows = await overlappingBlocks(c, s.organisation_id, cohort, s.starts_at, s.ends_at, exam_buffer_min);
  if (!rows.length) return out;
  const consent = new Map();
  for (const a of new Set(rows.map((r) => r.athlete_id))) consent.set(a, await hasConsent(a, 'academic', c));
  const done = new Set((await c.query('SELECT athlete_id, block_id FROM academy_clash_resolutions WHERE session_id=$1', [s.id ?? '00000000-0000-0000-0000-000000000000'])).rows.map((r) => `${r.athlete_id}:${r.block_id}`));
  for (const r of rows) {
    if (!consent.get(r.athlete_id)) continue;
    const base = { athlete_id: r.athlete_id, display_name: r.display_name, block_id: r.block_id, link_id: r.link_id, block_kind: r.kind, source_type: 'school_block', source_id: r.block_id };
    if (done.has(`${r.athlete_id}:${r.block_id}`)) { out.resolved.push({ ...base, code: 'school_clash_resolved', message: `${r.display_name} is excused for a ${KIND_LABEL[r.kind]}` }); continue; }
    if (r.direct && HARD_KINDS.includes(r.kind)) out.clashes.push({ ...base, kind: 'school', code: r.kind === 'exam' ? 'school_exam_clash' : 'school_commitment_clash', message: `${r.display_name} has a ${KIND_LABEL[r.kind]} at that time` });
    else if (r.direct) out.warnings.push({ ...base, kind: 'school', code: 'school_study_overlap', message: `${r.display_name} has ${KIND_LABEL[r.kind]} at that time` });
    else out.warnings.push({ ...base, kind: 'school', code: 'school_exam_buffer', message: `${r.display_name} has a school exam within ${exam_buffer_min} minutes of this session` });
  }
  return out;
}
