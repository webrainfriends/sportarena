// Referee Education, Exams & Progression (#1011)
// Course catalogue, enrolment, structured exam engine, attendance, practical evaluation,
// certificate issuance, licence-progression contribution, prerequisite reminders.
// Builds on existing CPD (off_cpd_records), credentials, federation-licences and off_events;
// does NOT duplicate those domains.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx, pool } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { notify } from '../notify.js';
import { bodyById, nextNumber, today, plain, LIC_STATUS } from '../federation.js';
import { devStaff, logOff, sealText, unsealText, CTX } from '../officials-development.js';
import { encrypt, decrypt } from '../crypto.js';

const TAG = 'Referee education';
const text = (n) => z.string().trim().min(1).max(n);
const textOpt = (n) => z.string().trim().max(n).optional();
const day = z.string().date();
const pct = z.number().min(0).max(100);
const EDU_CTX = {
  desc: 'off_edu_courses.description',
  answers: 'off_edu_exam_attempts.answers',
  feedback: 'off_edu_exam_attempts.feedback',
  notes: 'off_edu_practical_evaluations.notes',
  runNotes: 'off_edu_runs.notes',
  correctAnswer: 'off_edu_exam_questions.correct_answer',
};

// ------------------------------------------------------------------ helpers

async function loadCourse(id, c = pool) {
  const r = (await c.query('SELECT * FROM off_edu_courses WHERE id=$1', [id])).rows[0];
  if (!r) throw notFound('Course');
  return r;
}
async function loadRun(id, c = pool) {
  const r = (await c.query('SELECT r.*, c.governing_body_id, c.sport_id, c.title AS course_title, c.cpd_hours, c.validity_months, c.grading_schema, c.pass_mark AS course_pass_mark, c.practical_required, c.attendance_required_pct, c.exam_attempts_allowed FROM off_edu_runs r JOIN off_edu_courses c ON c.id=r.course_id WHERE r.id=$1', [id])).rows[0];
  if (!r) throw notFound('Course run');
  return r;
}
async function loadEnrolment(id, c = pool) {
  const r = (await c.query('SELECT e.*, r.course_id, r.governing_body_id, r.sport_id, r.course_title FROM off_edu_enrolments e JOIN (SELECT r2.id, c2.id AS course_id, c2.governing_body_id, c2.sport_id, c2.title AS course_title FROM off_edu_runs r2 JOIN off_edu_courses c2 ON c2.id=r2.course_id) r ON r.id=e.run_id WHERE e.id=$1', [id])).rows[0];
  if (!r) throw notFound('Enrolment');
  return r;
}
async function loadExam(id, c = pool) {
  const r = (await c.query('SELECT x.*, c.governing_body_id, c.sport_id, c.exam_attempts_allowed FROM off_edu_exams x JOIN off_edu_courses c ON c.id=x.course_id WHERE x.id=$1', [id])).rows[0];
  if (!r) throw notFound('Exam');
  return r;
}
async function loadAttempt(id, c = pool) {
  const r = (await c.query('SELECT a.*, x.course_id, x.pass_mark, x.max_attempts, c.governing_body_id FROM off_edu_exam_attempts a JOIN off_edu_exams x ON x.id=a.exam_id JOIN off_edu_courses c ON c.id=x.course_id WHERE a.id=$1', [id])).rows[0];
  if (!r) throw notFound('Exam attempt');
  return r;
}

/** Check all prerequisites for a course. Returns {met, missing[]}. */
export async function checkPrerequisites(licenceId, courseId, c = pool) {
  const prereqs = (await c.query('SELECT * FROM off_edu_course_prerequisites WHERE course_id=$1', [courseId])).rows;
  if (!prereqs.length) return { met: true, missing: [] };
  const missing = [];
  for (const p of prereqs) {
    if (p.required_course_id) {
      const cutoff = p.validity_months
        ? new Date(Date.now() - p.validity_months * 30 * 24 * 3600 * 1000).toISOString()
        : null;
      const done = (await c.query(
        `SELECT e.id, cert.expires_at FROM off_edu_enrolments e
           LEFT JOIN off_edu_certificates cert ON cert.enrolment_id=e.id
          WHERE e.licence_id=$1 AND e.run_id IN (SELECT id FROM off_edu_runs WHERE course_id=$2)
            AND e.status='completed'
            AND ($3::timestamptz IS NULL OR cert.expires_at IS NULL OR cert.expires_at > now())
         LIMIT 1`, [licenceId, p.required_course_id, cutoff])).rows[0];
      if (!done) {
        const course = (await c.query('SELECT title FROM off_edu_courses WHERE id=$1', [p.required_course_id])).rows[0];
        missing.push({ kind: 'course', course_id: p.required_course_id, title: course?.title ?? 'Unknown', validity_months: p.validity_months });
      }
    } else if (p.required_credential_kind) {
      const lic = (await c.query('SELECT l.holder_id FROM fed_licences l WHERE l.id=$1', [licenceId])).rows[0];
      if (lic) {
        const cred = (await c.query(
          `SELECT id FROM credentials WHERE holder_id=$1 AND kind=$2 AND (expires_at IS NULL OR expires_at > now()) AND revoked_at IS NULL LIMIT 1`,
          [lic.holder_id, p.required_credential_kind])).rows[0];
        if (!cred) missing.push({ kind: 'credential', credential_kind: p.required_credential_kind });
      }
    }
  }
  return { met: missing.length === 0, missing };
}

/** Award CPD on course completion. Inserts verified off_cpd_records entry. */
async function awardCourseCPD(enrolment, credentialId, c) {
  if (!enrolment.cpd_hours || enrolment.cpd_hours <= 0) return;
  await c.query(
    `INSERT INTO off_cpd_records(licence_id, body_id, activity, hours, evidence_enc, status, credential_id, verified_at, created_by, created_at)
     SELECT $1, (SELECT body_id FROM fed_licences WHERE id=$1), $2, $3, $4, 'verified', $5, now(), $6, now()
     ON CONFLICT DO NOTHING`,
    [enrolment.licence_id, `Completed course: ${enrolment.course_title}`, enrolment.cpd_hours,
     sealText(`Course ID ${enrolment.course_id}`, CTX.cpd), credentialId, enrolment.user_id]);
  await logOff(c, enrolment.governing_body_id, 'edu_cpd_award', enrolment.id, 'cpd_awarded',
    { actor: enrolment.user_id, detail: { cpd_hours: enrolment.cpd_hours, credential_id: credentialId } });
}

/** Issue a certificate credential for a completed enrolment. */
async function issueCertificate(enrolment, issuedBy, c) {
  const existing = (await c.query('SELECT id FROM off_edu_certificates WHERE enrolment_id=$1', [enrolment.id])).rows[0];
  if (existing) return existing;
  const holder = (await c.query('SELECT holder_id FROM fed_licences WHERE id=$1', [enrolment.licence_id])).rows[0];
  if (!holder) throw notFound('Licence holder');
  const course = (await c.query('SELECT * FROM off_edu_courses WHERE id=$1', [enrolment.course_id])).rows[0];
  const certNum = await nextNumber(c, 'EDU-CERT', enrolment.governing_body_id);
  const expiresAt = course.validity_months
    ? new Date(Date.now() + course.validity_months * 30 * 24 * 3600 * 1000).toISOString()
    : null;
  const cred = (await c.query(
    `INSERT INTO credentials(holder_id, issuer_id, kind, title, issued_at, expires_at, body_id, reference, created_at)
     VALUES ($1,(SELECT organisation_id FROM governing_bodies WHERE id=$2),'certificate',$3,now(),$4,$2,$5,now()) RETURNING id`,
    [holder.holder_id, enrolment.governing_body_id, course.title, expiresAt, certNum])).rows[0];
  const cert = (await c.query(
    `INSERT INTO off_edu_certificates(enrolment_id, credential_id, certificate_number, issued_at, issued_by, expires_at)
     VALUES ($1,$2,$3,now(),$4,$5) RETURNING *`,
    [enrolment.id, cred.id, certNum, issuedBy, expiresAt])).rows[0];
  await logOff(c, enrolment.governing_body_id, 'edu_certificate', cert.id, 'issued',
    { actor: issuedBy, detail: { course_id: enrolment.course_id, credential_id: cred.id } });
  await notify(holder.holder_id, 'edu_certificate_issued', { courseTitle: course.title, certNum });
  return cert;
}

/** Schedule prerequisite-expiry and certificate-expiry reminders. */
async function scheduleReminders(enrolment, certExpiresAt, c) {
  const rows = [];
  if (certExpiresAt) {
    const notifyAt = new Date(new Date(certExpiresAt).getTime() - 60 * 24 * 3600 * 1000).toISOString();
    rows.push([enrolment.licence_id, 'certificate_expiring', enrolment.id, notifyAt]);
  }
  const prereqs = (await c.query(
    'SELECT p.*, c.title FROM off_edu_course_prerequisites p LEFT JOIN off_edu_courses c ON c.id=p.required_course_id WHERE p.course_id=$1 AND p.validity_months IS NOT NULL',
    [enrolment.course_id])).rows;
  for (const p of prereqs) {
    const ref = p.required_course_id;
    if (!ref) continue;
    const cert = (await c.query(
      `SELECT cert.expires_at FROM off_edu_certificates cert
         JOIN off_edu_enrolments e ON e.id=cert.enrolment_id
        WHERE e.licence_id=$1 AND e.run_id IN (SELECT id FROM off_edu_runs WHERE course_id=$2) AND e.status='completed'
        ORDER BY cert.expires_at DESC LIMIT 1`, [enrolment.licence_id, ref])).rows[0];
    if (cert?.expires_at) {
      const notifyAt = new Date(new Date(cert.expires_at).getTime() - 60 * 24 * 3600 * 1000).toISOString();
      rows.push([enrolment.licence_id, 'prerequisite_expiring', ref, notifyAt]);
    }
  }
  for (const [lid, kind, refId, notifyAt] of rows) {
    await c.query(
      `INSERT INTO off_edu_reminders(licence_id, kind, reference_id, notify_at)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [lid, kind, refId, notifyAt]);
  }
}

// Auto-grade MCQ/true-false questions; returns {autoScore, needsManual}
async function autoGrade(examId, answersObj, c) {
  const qs = (await c.query(
    "SELECT id, kind, correct_key, marks FROM off_edu_exam_questions WHERE exam_id=$1 AND kind IN ('mcq','true_false')", [examId])).rows;
  const totalAuto = qs.reduce((s, q) => s + parseFloat(q.marks), 0);
  const totalAll = (await c.query('SELECT COALESCE(SUM(marks),0) AS t FROM off_edu_exam_questions WHERE exam_id=$1', [examId])).rows[0].t;
  let earned = 0;
  for (const q of qs) {
    if (String(answersObj[q.id]) === q.correct_key) earned += parseFloat(q.marks);
  }
  const pctAuto = totalAuto > 0 ? (earned / totalAll) * 100 : null;
  const needsManual = parseFloat(totalAll) > parseFloat(totalAuto);
  return { autoScore: pctAuto, needsManual };
}

// ------------------------------------------------------------------ course management

cap({
  name: 'create_edu_course', method: 'POST', path: '/officials-education/bodies/:id/courses', tag: TAG, status: 201,
  summary: 'Create a referee education course for a governing body. Body development staff only.',
  input: z.object({
    id,
    sport_id: id.optional(),
    title: text(200),
    kind: z.enum(['theory','practical','blended','online','assessment']),
    level: z.enum(['foundation','developing','performance','elite','national']),
    description: textOpt(5000),
    syllabus: z.array(z.object({ seq: z.number().int(), topic: text(300), duration_minutes: z.number().int().min(1).optional() })).optional(),
    learning_objectives: z.array(text(300)).max(20).optional(),
    cpd_hours: z.number().min(0).max(500).default(0),
    credit_units: z.number().int().min(0).max(100).optional(),
    min_grade_rank: z.number().int().min(0).optional(),
    duration_hours: z.number().min(0).max(2000).optional(),
    validity_months: z.number().int().min(1).max(120).optional(),
    grading_schema: z.enum(['pass_fail','percentage','grade','competency']).optional(),
    pass_mark: pct.optional(),
    exam_attempts_allowed: z.number().int().min(1).max(10).default(3),
    practical_required: z.boolean().default(false),
    attendance_required_pct: pct.default(100),
    price_amount: z.number().min(0).optional(),
    price_currency: z.string().length(3).optional(),
    pricebook_item_id: id.optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    await devStaff(user, i.id, { c, sportId: i.sport_id });
    const descEnc = i.description ? sealText(i.description, EDU_CTX.desc) : null;
    const r = (await c.query(
      `INSERT INTO off_edu_courses(governing_body_id, sport_id, title, kind, level, description_enc, syllabus, learning_objectives,
         cpd_hours, credit_units, min_grade_rank, duration_hours, validity_months, grading_schema, pass_mark,
         exam_attempts_allowed, practical_required, attendance_required_pct, price_amount, price_currency, pricebook_item_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
      [i.id, i.sport_id ?? null, i.title, i.kind, i.level, descEnc,
       i.syllabus ? JSON.stringify(i.syllabus) : null,
       i.learning_objectives ?? null,
       i.cpd_hours, i.credit_units ?? 0, i.min_grade_rank ?? null, i.duration_hours ?? null,
       i.validity_months ?? null, i.grading_schema ?? null, i.pass_mark ?? null,
       i.exam_attempts_allowed, i.practical_required, i.attendance_required_pct,
       i.price_amount ?? null, i.price_currency ?? null, i.pricebook_item_id ?? null, user.id])).rows[0];
    await logOff(c, i.id, 'edu_course', r.id, 'created', { actor: user.id });
    return plain(r);
  }),
});

cap({
  name: 'update_edu_course', method: 'PATCH', path: '/officials-education/courses/:id', tag: TAG,
  summary: 'Update a course (draft or published). row_version required for optimistic locking.',
  input: z.object({
    id,
    row_version: z.number().int(),
    title: text(200).optional(),
    kind: z.enum(['theory','practical','blended','online','assessment']).optional(),
    level: z.enum(['foundation','developing','performance','elite','national']).optional(),
    description: textOpt(5000),
    syllabus: z.array(z.object({ seq: z.number().int(), topic: text(300), duration_minutes: z.number().int().min(1).optional() })).optional(),
    learning_objectives: z.array(text(300)).max(20).optional(),
    cpd_hours: z.number().min(0).max(500).optional(),
    credit_units: z.number().int().min(0).max(100).optional(),
    min_grade_rank: z.number().int().min(0).nullable().optional(),
    duration_hours: z.number().min(0).max(2000).nullable().optional(),
    validity_months: z.number().int().min(1).max(120).nullable().optional(),
    grading_schema: z.enum(['pass_fail','percentage','grade','competency']).nullable().optional(),
    pass_mark: pct.nullable().optional(),
    exam_attempts_allowed: z.number().int().min(1).max(10).optional(),
    practical_required: z.boolean().optional(),
    attendance_required_pct: pct.optional(),
    price_amount: z.number().min(0).nullable().optional(),
    price_currency: z.string().length(3).nullable().optional(),
    pricebook_item_id: id.nullable().optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const course = await loadCourse(i.id, c);
    if (course.status === 'archived') throw badRequest('Archived courses cannot be edited');
    await devStaff(user, course.governing_body_id, { c });
    if (course.row_version !== i.row_version) throw conflict('Course was updated by someone else — reload and retry');
    const fields = [], vals = [];
    const set = (col, val) => { fields.push(`${col}=$${vals.push(val)}`); };
    if (i.title !== undefined) set('title', i.title);
    if (i.kind !== undefined) set('kind', i.kind);
    if (i.level !== undefined) set('level', i.level);
    if ('description' in i) set('description_enc', i.description ? sealText(i.description, EDU_CTX.desc) : null);
    if (i.syllabus !== undefined) set('syllabus', JSON.stringify(i.syllabus));
    if (i.learning_objectives !== undefined) set('learning_objectives', i.learning_objectives);
    if (i.cpd_hours !== undefined) set('cpd_hours', i.cpd_hours);
    if (i.credit_units !== undefined) set('credit_units', i.credit_units);
    if ('min_grade_rank' in i) set('min_grade_rank', i.min_grade_rank);
    if ('duration_hours' in i) set('duration_hours', i.duration_hours);
    if ('validity_months' in i) set('validity_months', i.validity_months);
    if ('grading_schema' in i) set('grading_schema', i.grading_schema);
    if ('pass_mark' in i) set('pass_mark', i.pass_mark);
    if (i.exam_attempts_allowed !== undefined) set('exam_attempts_allowed', i.exam_attempts_allowed);
    if (i.practical_required !== undefined) set('practical_required', i.practical_required);
    if (i.attendance_required_pct !== undefined) set('attendance_required_pct', i.attendance_required_pct);
    if ('price_amount' in i) set('price_amount', i.price_amount);
    if ('price_currency' in i) set('price_currency', i.price_currency);
    if ('pricebook_item_id' in i) set('pricebook_item_id', i.pricebook_item_id);
    if (!fields.length) return plain(course);
    set('row_version', course.row_version + 1);
    set('updated_at', new Date().toISOString());
    const r = (await c.query(`UPDATE off_edu_courses SET ${fields.join(',')} WHERE id=$${vals.push(i.id)} RETURNING *`, vals)).rows[0];
    await logOff(c, course.governing_body_id, 'edu_course', i.id, 'updated', { actor: user.id });
    return plain(r);
  }),
});

cap({
  name: 'publish_edu_course', method: 'POST', path: '/officials-education/courses/:id/publish', tag: TAG,
  summary: 'Publish a course so officials can browse and enrol.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const course = await loadCourse(i.id, c);
    if (course.status !== 'draft') throw badRequest('Only draft courses can be published');
    await devStaff(user, course.governing_body_id, { c });
    const r = (await c.query('UPDATE off_edu_courses SET status=$1, published_at=now(), updated_at=now(), row_version=row_version+1 WHERE id=$2 RETURNING *', ['published', i.id])).rows[0];
    await logOff(c, course.governing_body_id, 'edu_course', i.id, 'published', { actor: user.id });
    return plain(r);
  }),
});

cap({
  name: 'archive_edu_course', method: 'POST', path: '/officials-education/courses/:id/archive', tag: TAG,
  summary: 'Archive a course. No new enrolments are accepted; existing ones continue.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const course = await loadCourse(i.id, c);
    if (course.status === 'archived') throw badRequest('Course is already archived');
    await devStaff(user, course.governing_body_id, { c });
    const r = (await c.query('UPDATE off_edu_courses SET status=$1, archived_at=now(), updated_at=now(), row_version=row_version+1 WHERE id=$2 RETURNING *', ['archived', i.id])).rows[0];
    await logOff(c, course.governing_body_id, 'edu_course', i.id, 'archived', { actor: user.id });
    return plain(r);
  }),
});

cap({
  name: 'list_edu_courses', method: 'GET', path: '/officials-education/bodies/:id/courses', tag: TAG, auth: 'public',
  summary: 'Browse the course catalogue for a governing body. Public for published courses; staff see all.',
  input: z.object({ id, sport_id: id.optional(), kind: z.string().optional(), level: z.string().optional(), status: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0) }),
  async handler({ user }, i) {
    await bodyById(i.id);
    const isStaff = user ? await devStaff(user, i.id, { optional: true }).then(r => !!r?.staff).catch(() => false) : false;
    const statusFilter = i.status ?? (isStaff ? null : 'published');
    return many(
      `SELECT c.id, c.governing_body_id, c.sport_id, s.name AS sport_name, c.title, c.kind, c.level, c.cpd_hours, c.credit_units,
              c.duration_hours, c.validity_months, c.grading_schema, c.pass_mark, c.practical_required, c.attendance_required_pct,
              c.price_amount, c.price_currency, c.status, c.published_at, c.row_version, c.created_at,
              (SELECT COUNT(*) FROM off_edu_course_prerequisites WHERE course_id=c.id) AS prerequisite_count,
              (SELECT COUNT(*) FROM off_edu_runs WHERE course_id=c.id AND status IN ('open','in_progress')) AS active_run_count,
              (SELECT MIN(start_date) FROM off_edu_runs WHERE course_id=c.id AND status='open' AND start_date >= CURRENT_DATE) AS next_run_date
         FROM off_edu_courses c LEFT JOIN sports s ON s.id=c.sport_id
        WHERE c.governing_body_id=$1
          AND ($2::uuid IS NULL OR c.sport_id=$2)
          AND ($3::text IS NULL OR c.kind=$3)
          AND ($4::text IS NULL OR c.level=$4)
          AND ($5::text IS NULL OR c.status=$5)
        ORDER BY c.level, c.title
        LIMIT $6 OFFSET $7`,
      [i.id, i.sport_id ?? null, i.kind ?? null, i.level ?? null, statusFilter, i.limit, i.offset]);
  },
});

cap({
  name: 'get_edu_course', method: 'GET', path: '/officials-education/courses/:id', tag: TAG, auth: 'public',
  summary: 'Full course detail including prerequisites, exams and upcoming runs.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const course = await loadCourse(i.id);
    const isStaff = user ? await devStaff(user, course.governing_body_id, { optional: true }).then(r => !!r?.staff).catch(() => false) : false;
    if (course.status !== 'published' && !isStaff) throw notFound('Course');
    const prereqs = await many('SELECT p.*, c.title AS required_course_title FROM off_edu_course_prerequisites p LEFT JOIN off_edu_courses c ON c.id=p.required_course_id WHERE p.course_id=$1', [i.id]);
    const exams = await many("SELECT id, title, kind, time_limit_minutes, pass_mark, max_attempts, weight, status FROM off_edu_exams WHERE course_id=$1 AND status='published'", [i.id]);
    const runs = await many("SELECT id, run_code, delivery_mode, venue_name_at_time, start_date, end_date, max_enrolments, enrolment_deadline, status, (SELECT COUNT(*) FROM off_edu_enrolments WHERE run_id=r.id AND status NOT IN ('withdrawn')) AS enrolled_count FROM off_edu_runs r WHERE course_id=$1 AND status IN ('open','in_progress') ORDER BY start_date LIMIT 10", [i.id]);
    return { ...plain(course), prerequisites: prereqs, exams, runs };
  },
});

cap({
  name: 'add_course_prerequisite', method: 'POST', path: '/officials-education/courses/:id/prerequisites', tag: TAG, status: 201,
  summary: 'Add a prerequisite (another course or credential kind) to a course.',
  input: z.object({ id, required_course_id: id.optional(), required_credential_kind: textOpt(100), validity_months: z.number().int().min(1).max(120).optional() })
    .refine(r => r.required_course_id || r.required_credential_kind, 'Either required_course_id or required_credential_kind must be provided'),
  handler: ({ user }, i) => tx(async (c) => {
    const course = await loadCourse(i.id, c);
    await devStaff(user, course.governing_body_id, { c });
    if (i.required_course_id === i.id) throw badRequest('A course cannot be its own prerequisite');
    const r = (await c.query(
      'INSERT INTO off_edu_course_prerequisites(course_id, required_course_id, required_credential_kind, validity_months) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING *',
      [i.id, i.required_course_id ?? null, i.required_credential_kind ?? null, i.validity_months ?? null])).rows[0];
    return r ?? (await c.query('SELECT * FROM off_edu_course_prerequisites WHERE course_id=$1 AND required_course_id IS NOT DISTINCT FROM $2', [i.id, i.required_course_id ?? null])).rows[0];
  }),
});

// ------------------------------------------------------------------ course runs

cap({
  name: 'create_edu_run', method: 'POST', path: '/officials-education/courses/:id/runs', tag: TAG, status: 201,
  summary: 'Schedule a delivery run for a course.',
  input: z.object({
    id,
    run_code: textOpt(50),
    delivery_mode: z.enum(['in_person','online','hybrid']).default('in_person'),
    venue_id: id.optional(),
    venue_name_at_time: textOpt(200),
    instructor_ids: z.array(id).max(20).optional(),
    start_date: day,
    end_date: day,
    max_enrolments: z.number().int().min(1).max(5000).optional(),
    enrolment_deadline: day.optional(),
    notes: textOpt(2000),
  }).refine(r => r.end_date >= r.start_date, 'End date must be on or after start date'),
  handler: ({ user }, i) => tx(async (c) => {
    const course = await loadCourse(i.id, c);
    if (course.status === 'archived') throw badRequest('Cannot create runs for an archived course');
    await devStaff(user, course.governing_body_id, { c });
    const notesEnc = i.notes ? sealText(i.notes, EDU_CTX.runNotes) : null;
    const r = (await c.query(
      `INSERT INTO off_edu_runs(course_id, run_code, delivery_mode, venue_id, venue_name_at_time, instructor_ids, start_date, end_date, max_enrolments, enrolment_deadline, notes_enc, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [i.id, i.run_code ?? null, i.delivery_mode, i.venue_id ?? null, i.venue_name_at_time ?? null,
       i.instructor_ids ?? null, i.start_date, i.end_date, i.max_enrolments ?? null, i.enrolment_deadline ?? null, notesEnc, user.id])).rows[0];
    await logOff(c, course.governing_body_id, 'edu_run', r.id, 'created', { actor: user.id });
    return plain(r);
  }),
});

cap({
  name: 'update_edu_run', method: 'PATCH', path: '/officials-education/runs/:id', tag: TAG,
  summary: 'Update a course run (before or during delivery).',
  input: z.object({
    id, row_version: z.number().int(),
    delivery_mode: z.enum(['in_person','online','hybrid']).optional(),
    venue_id: id.nullable().optional(),
    venue_name_at_time: textOpt(200),
    instructor_ids: z.array(id).max(20).optional(),
    start_date: day.optional(),
    end_date: day.optional(),
    max_enrolments: z.number().int().min(1).nullable().optional(),
    enrolment_deadline: day.nullable().optional(),
    status: z.enum(['open','closed','in_progress','completed','cancelled']).optional(),
    notes: textOpt(2000),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const run = await loadRun(i.id, c);
    await devStaff(user, run.governing_body_id, { c });
    if (run.row_version !== i.row_version) throw conflict('Run was updated — reload and retry');
    const fields = [], vals = [];
    const set = (col, val) => { fields.push(`${col}=$${vals.push(val)}`); };
    if (i.delivery_mode !== undefined) set('delivery_mode', i.delivery_mode);
    if ('venue_id' in i) set('venue_id', i.venue_id);
    if ('venue_name_at_time' in i) set('venue_name_at_time', i.venue_name_at_time);
    if (i.instructor_ids !== undefined) set('instructor_ids', i.instructor_ids);
    if (i.start_date !== undefined) set('start_date', i.start_date);
    if (i.end_date !== undefined) set('end_date', i.end_date);
    if ('max_enrolments' in i) set('max_enrolments', i.max_enrolments);
    if ('enrolment_deadline' in i) set('enrolment_deadline', i.enrolment_deadline);
    if (i.status !== undefined) set('status', i.status);
    if ('notes' in i) set('notes_enc', i.notes ? sealText(i.notes, EDU_CTX.runNotes) : null);
    if (!fields.length) return plain(run);
    set('row_version', run.row_version + 1);
    const r = (await c.query(`UPDATE off_edu_runs SET ${fields.join(',')} WHERE id=$${vals.push(i.id)} RETURNING *`, vals)).rows[0];
    await logOff(c, run.governing_body_id, 'edu_run', i.id, 'updated', { actor: user.id });
    return plain(r);
  }),
});

cap({
  name: 'add_edu_session', method: 'POST', path: '/officials-education/runs/:id/sessions', tag: TAG, status: 201,
  summary: 'Add a session to a run. Session numbers are auto-incremented.',
  input: z.object({ id, title: textOpt(200), scheduled_at: z.string().datetime(), duration_minutes: z.number().int().min(1).max(1440).optional(), topic: textOpt(300), is_practical: z.boolean().default(false) }),
  handler: ({ user }, i) => tx(async (c) => {
    const run = await loadRun(i.id, c);
    await devStaff(user, run.governing_body_id, { c });
    const next = (await c.query('SELECT COALESCE(MAX(session_number),0)+1 AS n FROM off_edu_sessions WHERE run_id=$1', [i.id])).rows[0].n;
    const r = (await c.query(
      'INSERT INTO off_edu_sessions(run_id, session_number, title, scheduled_at, duration_minutes, topic, is_practical) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [i.id, next, i.title ?? null, i.scheduled_at, i.duration_minutes ?? null, i.topic ?? null, i.is_practical])).rows[0];
    return plain(r);
  }),
});

cap({
  name: 'list_edu_runs', method: 'GET', path: '/officials-education/courses/:id/runs', tag: TAG, auth: 'public',
  summary: 'List scheduled runs for a course.',
  input: z.object({ id, status: z.string().optional() }),
  async handler(_ctx, i) {
    const course = await loadCourse(i.id);
    return many(
      `SELECT r.*, (SELECT COUNT(*) FROM off_edu_enrolments WHERE run_id=r.id AND status NOT IN ('withdrawn')) AS enrolled_count,
              (SELECT json_agg(s ORDER BY s.session_number) FROM off_edu_sessions s WHERE s.run_id=r.id) AS sessions
         FROM off_edu_runs r
        WHERE r.course_id=$1 AND ($2::text IS NULL OR r.status=$2)
        ORDER BY r.start_date`,
      [i.id, i.status ?? null]);
  },
});

// ------------------------------------------------------------------ enrolment

cap({
  name: 'apply_enrolment', method: 'POST', path: '/officials-education/runs/:id/enrolments', tag: TAG, status: 201,
  summary: 'Official applies to enrol in a course run. Prerequisite and capacity checks are enforced.',
  input: z.object({ id, licence_id: id, idempotency_key: textOpt(100) }),
  handler: ({ user }, i) => tx(async (c) => {
    const run = await loadRun(i.id, c);
    if (!['open'].includes(run.status)) throw badRequest(`Enrolment is not open (run status: ${run.status})`);
    if (run.enrolment_deadline && run.enrolment_deadline < today()) throw badRequest('Enrolment deadline has passed');
    const lic = (await c.query('SELECT * FROM fed_licences WHERE id=$1 AND holder_id=$2', [i.licence_id, user.id])).rows[0];
    if (!lic) throw notFound('Licence');
    if (run.max_enrolments) {
      const count = (await c.query("SELECT COUNT(*) AS n FROM off_edu_enrolments WHERE run_id=$1 AND status NOT IN ('withdrawn')", [i.id])).rows[0].n;
      if (parseInt(count) >= run.max_enrolments) throw conflict('This run is fully booked');
    }
    const { met, missing } = await checkPrerequisites(i.licence_id, run.course_id, c);
    if (!met) return { prerequisite_check: { met: false, missing }, enrolment: null };
    const idKey = i.idempotency_key ?? null;
    const r = (await c.query(
      `INSERT INTO off_edu_enrolments(run_id, licence_id, user_id, status, idempotency_key)
       VALUES ($1,$2,$3,'applied',$4)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE SET run_id=EXCLUDED.run_id RETURNING *`,
      [i.id, i.licence_id, user.id, idKey])).rows[0];
    await logOff(c, run.governing_body_id, 'edu_enrolment', r.id, 'applied', { actor: user.id, to: 'applied' });
    // Notify body staff
    const staffers = (await c.query(
      "SELECT u.id FROM users u JOIN fed_staff_members fs ON fs.user_id=u.id WHERE fs.body_id=$1 AND fs.permission='licences' AND fs.archived_at IS NULL LIMIT 5",
      [run.governing_body_id])).rows;
    for (const s of staffers) await notify(s.id, 'edu_enrolment_applied', { courseTitle: run.course_title, runCode: run.run_code ?? run.id.slice(0,8) });
    return { prerequisite_check: { met: true, missing: [] }, enrolment: plain(r) };
  }),
});

cap({
  name: 'enrol_official', method: 'POST', path: '/officials-education/enrolments/:id/enrol', tag: TAG,
  summary: 'Body staff confirms enrolment (moves from applied to enrolled).',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const enr = await loadEnrolment(i.id, c);
    if (enr.status !== 'applied' && enr.status !== 'waitlisted') throw badRequest(`Cannot enrol from status '${enr.status}'`);
    await devStaff(user, enr.governing_body_id, { c });
    const r = (await c.query('UPDATE off_edu_enrolments SET status=$1, enrolment_date=$2, updated_at=now(), row_version=row_version+1 WHERE id=$3 RETURNING *', ['enrolled', today(), i.id])).rows[0];
    await logOff(c, enr.governing_body_id, 'edu_enrolment', i.id, 'enrolled', { actor: user.id, from: enr.status, to: 'enrolled' });
    await notify(enr.user_id, 'edu_enrolment_confirmed', { courseTitle: enr.course_title });
    return plain(r);
  }),
});

cap({
  name: 'withdraw_enrolment', method: 'POST', path: '/officials-education/enrolments/:id/withdraw', tag: TAG,
  summary: 'Withdraw an enrolment. Can be done by the official (own) or body staff.',
  input: z.object({ id, reason: textOpt(500) }),
  handler: ({ user }, i) => tx(async (c) => {
    const enr = await loadEnrolment(i.id, c);
    if (enr.status === 'withdrawn') throw badRequest('Already withdrawn');
    if (enr.status === 'completed') throw badRequest('Completed enrolments cannot be withdrawn');
    if (enr.user_id !== user.id) await devStaff(user, enr.governing_body_id, { c });
    const r = (await c.query('UPDATE off_edu_enrolments SET status=$1, withdrawal_reason=$2, updated_at=now(), row_version=row_version+1 WHERE id=$3 RETURNING *', ['withdrawn', i.reason ?? null, i.id])).rows[0];
    await logOff(c, enr.governing_body_id, 'edu_enrolment', i.id, 'withdrawn', { actor: user.id, from: enr.status, to: 'withdrawn', reason: i.reason });
    return plain(r);
  }),
});

cap({
  name: 'complete_enrolment', method: 'POST', path: '/officials-education/enrolments/:id/complete', tag: TAG,
  summary: 'Mark an enrolment as completed with a final score and outcome. Issues certificate and CPD award.',
  input: z.object({ id, final_score: pct.optional(), outcome: z.enum(['pass','fail','distinction','merit','competent','not_yet_competent']) }),
  handler: ({ user }, i) => tx(async (c) => {
    const enr = await loadEnrolment(i.id, c);
    if (!['enrolled','attending'].includes(enr.status)) throw badRequest(`Cannot complete from status '${enr.status}'`);
    await devStaff(user, enr.governing_body_id, { c });
    const r = (await c.query(
      'UPDATE off_edu_enrolments SET status=$1, outcome=$2, final_score=$3, completion_date=$4, updated_at=now(), row_version=row_version+1 WHERE id=$5 RETURNING *',
      ['completed', i.outcome, i.final_score ?? null, today(), i.id])).rows[0];
    await logOff(c, enr.governing_body_id, 'edu_enrolment', i.id, 'completed', { actor: user.id, to: 'completed', detail: { outcome: i.outcome } });
    let cert = null;
    if (['pass','distinction','merit','competent'].includes(i.outcome)) {
      cert = await issueCertificate({ ...enr, ...r }, user.id, c);
      await awardCourseCPD({ ...enr, ...r }, cert.credential_id, c);
      await scheduleReminders({ ...enr, ...r }, cert.expires_at, c);
    }
    return { enrolment: plain(r), certificate: cert };
  }),
});

cap({
  name: 'fail_enrolment', method: 'POST', path: '/officials-education/enrolments/:id/fail', tag: TAG,
  summary: 'Mark an enrolment as failed.',
  input: z.object({ id, final_score: pct.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const enr = await loadEnrolment(i.id, c);
    if (!['enrolled','attending'].includes(enr.status)) throw badRequest(`Cannot fail from status '${enr.status}'`);
    await devStaff(user, enr.governing_body_id, { c });
    const r = (await c.query('UPDATE off_edu_enrolments SET status=$1, outcome=$2, final_score=$3, completion_date=$4, updated_at=now(), row_version=row_version+1 WHERE id=$5 RETURNING *', ['failed', 'fail', i.final_score ?? null, today(), i.id])).rows[0];
    await logOff(c, enr.governing_body_id, 'edu_enrolment', i.id, 'failed', { actor: user.id, to: 'failed' });
    await notify(enr.user_id, 'edu_enrolment_failed', { courseTitle: enr.course_title });
    return plain(r);
  }),
});

cap({
  name: 'list_enrolments', method: 'GET', path: '/officials-education/runs/:id/enrolments', tag: TAG,
  summary: 'List all enrolments for a run (body staff only).',
  input: z.object({ id, status: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(100), offset: z.coerce.number().int().min(0).default(0) }),
  handler: ({ user }, i) => tx(async (c) => {
    const run = await loadRun(i.id, c);
    await devStaff(user, run.governing_body_id, { c });
    return many(
      `SELECT e.*, u.display_name, u.avatar_url, l.licence_no, l.type_id,
              (SELECT COUNT(*) FROM off_edu_attendance WHERE enrolment_id=e.id AND status='present') AS sessions_present,
              (SELECT COUNT(*) FROM off_edu_sessions WHERE run_id=$1) AS sessions_total
         FROM off_edu_enrolments e JOIN users u ON u.id=e.user_id JOIN fed_licences l ON l.id=e.licence_id
        WHERE e.run_id=$1 AND ($2::text IS NULL OR e.status=$2)
        ORDER BY u.display_name LIMIT $3 OFFSET $4`,
      [i.id, i.status ?? null, i.limit, i.offset]);
  }),
});

cap({
  name: 'get_my_enrolments', method: 'GET', path: '/officials-education/my-enrolments', tag: TAG,
  summary: "Get current user's enrolments with course and run details.",
  input: z.object({ status: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0) }),
  async handler({ user }, i) {
    return many(
      `SELECT e.*, r.start_date, r.end_date, r.delivery_mode, r.venue_name_at_time, r.status AS run_status,
              c.id AS course_id, c.title AS course_title, c.kind, c.level, c.cpd_hours, c.sport_id, s.name AS sport_name,
              c.governing_body_id, b.name AS body_name,
              (SELECT COUNT(*) FROM off_edu_attendance WHERE enrolment_id=e.id AND status='present') AS sessions_present,
              (SELECT COUNT(*) FROM off_edu_sessions WHERE run_id=e.run_id) AS sessions_total,
              (SELECT row_to_json(cert) FROM off_edu_certificates cert WHERE cert.enrolment_id=e.id) AS certificate
         FROM off_edu_enrolments e
         JOIN off_edu_runs r ON r.id=e.run_id
         JOIN off_edu_courses c ON c.id=r.course_id
         LEFT JOIN sports s ON s.id=c.sport_id
         JOIN governing_bodies gb ON gb.id=c.governing_body_id
         JOIN organisations b ON b.id=gb.organisation_id
        WHERE e.user_id=$1 AND ($2::text IS NULL OR e.status=$2)
        ORDER BY e.created_at DESC LIMIT $3 OFFSET $4`,
      [user.id, i.status ?? null, i.limit, i.offset]);
  },
});

// ------------------------------------------------------------------ attendance

cap({
  name: 'mark_attendance', method: 'POST', path: '/officials-education/sessions/:id/attendance', tag: TAG,
  summary: "Mark or update a single official's attendance for a session (upsert).",
  input: z.object({ id, enrolment_id: id, status: z.enum(['present','absent','excused','late']), note: textOpt(500) }),
  handler: ({ user }, i) => tx(async (c) => {
    const sess = (await c.query('SELECT s.*, r.governing_body_id FROM off_edu_sessions s JOIN off_edu_runs r ON r.id=s.run_id WHERE s.id=$1', [i.id])).rows[0];
    if (!sess) throw notFound('Session');
    await devStaff(user, sess.governing_body_id, { c });
    const enr = (await c.query('SELECT id FROM off_edu_enrolments WHERE id=$1 AND run_id=$2', [i.enrolment_id, sess.run_id])).rows[0];
    if (!enr) throw badRequest('Enrolment does not belong to this session\'s run');
    const r = (await c.query(
      `INSERT INTO off_edu_attendance(session_id, enrolment_id, status, marked_by, note)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (session_id, enrolment_id) DO UPDATE SET status=$3, marked_by=$4, marked_at=now(), note=$5
       RETURNING *`,
      [i.id, i.enrolment_id, i.status, user.id, i.note ?? null])).rows[0];
    return plain(r);
  }),
});

cap({
  name: 'get_session_attendance', method: 'GET', path: '/officials-education/sessions/:id/attendance', tag: TAG,
  summary: 'Get the attendance roster for a session.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const sess = (await c.query('SELECT s.*, r.governing_body_id FROM off_edu_sessions s JOIN off_edu_runs r ON r.id=s.run_id WHERE s.id=$1', [i.id])).rows[0];
    if (!sess) throw notFound('Session');
    await devStaff(user, sess.governing_body_id, { c });
    return many(
      `SELECT a.*, u.display_name, u.avatar_url, e.licence_id
         FROM off_edu_enrolments e
         LEFT JOIN off_edu_attendance a ON a.enrolment_id=e.id AND a.session_id=$1
         JOIN users u ON u.id=e.user_id
        WHERE e.run_id=$2 AND e.status NOT IN ('withdrawn')
        ORDER BY u.display_name`,
      [i.id, sess.run_id]);
  }),
});

// ------------------------------------------------------------------ exam management

cap({
  name: 'create_edu_exam', method: 'POST', path: '/officials-education/courses/:id/exams', tag: TAG, status: 201,
  summary: 'Create a theory or practical exam for a course.',
  input: z.object({
    id,
    title: text(200),
    kind: z.enum(['theory','practical_written','scenario','mcq','short_answer']),
    instructions: textOpt(3000),
    time_limit_minutes: z.number().int().min(1).max(480).optional(),
    pass_mark: pct.optional(),
    max_attempts: z.number().int().min(1).max(10).default(3),
    randomise_questions: z.boolean().default(true),
    show_answers_after: z.enum(['immediately','after_deadline','never']).optional(),
    is_practical: z.boolean().default(false),
    weight: z.number().min(1).max(100).default(100),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const course = await loadCourse(i.id, c);
    await devStaff(user, course.governing_body_id, { c });
    const r = (await c.query(
      `INSERT INTO off_edu_exams(course_id, title, kind, instructions, time_limit_minutes, pass_mark, max_attempts, randomise_questions, show_answers_after, is_practical, weight, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [i.id, i.title, i.kind, i.instructions ?? null, i.time_limit_minutes ?? null, i.pass_mark ?? null,
       i.max_attempts, i.randomise_questions, i.show_answers_after ?? 'never', i.is_practical, i.weight, user.id])).rows[0];
    await logOff(c, course.governing_body_id, 'edu_exam', r.id, 'created', { actor: user.id });
    return plain(r);
  }),
});

cap({
  name: 'add_exam_question', method: 'POST', path: '/officials-education/exams/:id/questions', tag: TAG, status: 201,
  summary: 'Add a question to an exam (must be draft). correct_answer encrypted for short_answer questions.',
  input: z.object({
    id,
    kind: z.enum(['mcq','true_false','short_answer','scenario','practical']),
    stem: text(2000),
    options: z.array(z.object({ key: z.string().min(1).max(5), text: text(500) })).max(8).optional(),
    correct_key: textOpt(5),
    correct_answer: textOpt(2000),
    marks: z.number().min(0.5).max(100).default(1),
    mandatory: z.boolean().default(true),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const exam = await loadExam(i.id, c);
    if (exam.status !== 'draft') throw badRequest('Questions can only be added to draft exams');
    await devStaff(user, exam.governing_body_id, { c });
    const nextSeq = (await c.query('SELECT COALESCE(MAX(seq),0)+1 AS n FROM off_edu_exam_questions WHERE exam_id=$1', [i.id])).rows[0].n;
    const correctEnc = i.correct_answer ? encrypt(i.correct_answer, EDU_CTX.correctAnswer) : null;
    const r = (await c.query(
      `INSERT INTO off_edu_exam_questions(exam_id, seq, kind, stem, options, correct_key, correct_answer_enc, marks, mandatory)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [i.id, nextSeq, i.kind, i.stem, i.options ? JSON.stringify(i.options) : null, i.correct_key ?? null, correctEnc, i.marks, i.mandatory])).rows[0];
    return plain(r);
  }),
});

cap({
  name: 'update_exam_question', method: 'PATCH', path: '/officials-education/exam-questions/:id', tag: TAG,
  summary: 'Update an exam question (exam must be draft).',
  input: z.object({
    id,
    stem: text(2000).optional(),
    options: z.array(z.object({ key: z.string().min(1).max(5), text: text(500) })).max(8).optional(),
    correct_key: textOpt(5),
    correct_answer: textOpt(2000),
    marks: z.number().min(0.5).max(100).optional(),
    mandatory: z.boolean().optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const q = (await c.query('SELECT q.*, x.governing_body_id, x.status AS exam_status FROM off_edu_exam_questions q JOIN off_edu_exams x ON x.id=q.exam_id JOIN off_edu_courses c ON c.id=x.course_id WHERE q.id=$1', [i.id])).rows[0];
    if (!q) throw notFound('Question');
    if (q.exam_status !== 'draft') throw badRequest('Questions can only be edited on draft exams');
    await devStaff(user, q.governing_body_id, { c });
    const fields = [], vals = [];
    const set = (col, val) => { fields.push(`${col}=$${vals.push(val)}`); };
    if (i.stem !== undefined) set('stem', i.stem);
    if (i.options !== undefined) set('options', JSON.stringify(i.options));
    if ('correct_key' in i) set('correct_key', i.correct_key);
    if ('correct_answer' in i) set('correct_answer_enc', i.correct_answer ? encrypt(i.correct_answer, EDU_CTX.correctAnswer) : null);
    if (i.marks !== undefined) set('marks', i.marks);
    if (i.mandatory !== undefined) set('mandatory', i.mandatory);
    if (!fields.length) return plain(q);
    const r = (await c.query(`UPDATE off_edu_exam_questions SET ${fields.join(',')} WHERE id=$${vals.push(i.id)} RETURNING *`, vals)).rows[0];
    return plain(r);
  }),
});

cap({
  name: 'publish_edu_exam', method: 'POST', path: '/officials-education/exams/:id/publish', tag: TAG,
  summary: 'Publish an exam so enrolled officials can attempt it. Requires at least one question.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const exam = await loadExam(i.id, c);
    if (exam.status !== 'draft') throw badRequest('Only draft exams can be published');
    await devStaff(user, exam.governing_body_id, { c });
    const qCount = (await c.query('SELECT COUNT(*) AS n FROM off_edu_exam_questions WHERE exam_id=$1', [i.id])).rows[0].n;
    if (parseInt(qCount) === 0) throw badRequest('Add at least one question before publishing');
    const r = (await c.query('UPDATE off_edu_exams SET status=$1, row_version=row_version+1 WHERE id=$2 RETURNING *', ['published', i.id])).rows[0];
    await logOff(c, exam.governing_body_id, 'edu_exam', i.id, 'published', { actor: user.id });
    return plain(r);
  }),
});

// ------------------------------------------------------------------ exam attempts

cap({
  name: 'start_exam_attempt', method: 'POST', path: '/officials-education/exams/:id/attempts', tag: TAG, status: 201,
  summary: 'Start a new exam attempt. Official must be enrolled; attempt limits enforced.',
  input: z.object({ id, enrolment_id: id }),
  handler: ({ user }, i) => tx(async (c) => {
    const exam = await loadExam(i.id, c);
    if (exam.status !== 'published') throw badRequest('Exam is not published');
    const enr = (await c.query('SELECT * FROM off_edu_enrolments WHERE id=$1 AND user_id=$2 AND run_id IN (SELECT id FROM off_edu_runs WHERE course_id=$3)', [i.enrolment_id, user.id, exam.course_id])).rows[0];
    if (!enr) throw notFound('Enrolment');
    if (!['enrolled','attending'].includes(enr.status)) throw badRequest('You must be enrolled to attempt this exam');
    const maxAttempts = exam.max_attempts;
    const used = (await c.query('SELECT COUNT(*) AS n FROM off_edu_exam_attempts WHERE exam_id=$1 AND enrolment_id=$2 AND voided_at IS NULL', [i.id, i.enrolment_id])).rows[0].n;
    if (parseInt(used) >= maxAttempts) throw conflict(`Maximum ${maxAttempts} attempts allowed`);
    const open = (await c.query('SELECT id FROM off_edu_exam_attempts WHERE exam_id=$1 AND enrolment_id=$2 AND submitted_at IS NULL AND voided_at IS NULL LIMIT 1', [i.id, i.enrolment_id])).rows[0];
    if (open) return { attempt: open, questions: await loadQuestionsForAttempt(i.id, exam.randomise_questions, c) };
    const attemptNum = parseInt(used) + 1;
    const r = (await c.query(
      'INSERT INTO off_edu_exam_attempts(exam_id, enrolment_id, attempt_number, answers_enc) VALUES ($1,$2,$3,$4) RETURNING *',
      [i.id, i.enrolment_id, attemptNum, encrypt('{}', EDU_CTX.answers)])).rows[0];
    return { attempt: plain(r), questions: await loadQuestionsForAttempt(i.id, exam.randomise_questions, c) };
  }),
});

async function loadQuestionsForAttempt(examId, randomise, c) {
  const qs = (await c.query('SELECT id, seq, kind, stem, options, marks, mandatory FROM off_edu_exam_questions WHERE exam_id=$1 ORDER BY seq', [examId])).rows;
  return randomise ? qs.sort(() => Math.random() - 0.5) : qs;
}

cap({
  name: 'submit_exam_attempt', method: 'POST', path: '/officials-education/exam-attempts/:id/submit', tag: TAG,
  summary: 'Submit an exam attempt with answers. MCQ/T-F questions auto-graded immediately.',
  input: z.object({ id, answers: z.record(z.string()) }),
  handler: ({ user }, i) => tx(async (c) => {
    const attempt = await loadAttempt(i.id, c);
    if (attempt.submitted_at) throw conflict('Attempt already submitted');
    if (attempt.voided_at) throw badRequest('Attempt has been voided');
    const enr = (await c.query('SELECT user_id FROM off_edu_enrolments WHERE id=$1', [attempt.enrolment_id])).rows[0];
    if (!enr || enr.user_id !== user.id) throw forbidden('Not your attempt');
    const answersEnc = encrypt(JSON.stringify(i.answers), EDU_CTX.answers);
    const { autoScore, needsManual } = await autoGrade(attempt.exam_id, i.answers, c);
    const outcome = !needsManual && autoScore !== null
      ? (attempt.pass_mark ? (autoScore >= parseFloat(attempt.pass_mark) ? 'pass' : 'fail') : 'pending')
      : 'pending';
    const r = (await c.query(
      'UPDATE off_edu_exam_attempts SET answers_enc=$1, auto_score=$2, outcome=$3, submitted_at=now() WHERE id=$4 RETURNING *',
      [answersEnc, autoScore, outcome, i.id])).rows[0];
    if (needsManual) {
      const staffers = (await c.query(
        "SELECT u.id FROM users u JOIN fed_staff_members fs ON fs.user_id=u.id WHERE fs.body_id=$1 AND fs.permission='licences' AND fs.archived_at IS NULL LIMIT 5",
        [attempt.governing_body_id])).rows;
      for (const s of staffers) await notify(s.id, 'edu_exam_needs_grading', { attemptId: i.id });
    }
    return plain(r);
  }),
});

cap({
  name: 'grade_exam_attempt', method: 'POST', path: '/officials-education/exam-attempts/:id/grade', tag: TAG,
  summary: 'Body staff manually grades an exam attempt (required for short-answer/practical written exams).',
  input: z.object({ id, manual_score: pct, feedback: textOpt(3000) }),
  handler: ({ user }, i) => tx(async (c) => {
    const attempt = await loadAttempt(i.id, c);
    if (!attempt.submitted_at) throw badRequest('Attempt not yet submitted');
    if (attempt.voided_at) throw badRequest('Attempt has been voided');
    await devStaff(user, attempt.governing_body_id, { c });
    const enr = (await c.query('SELECT user_id FROM off_edu_enrolments WHERE id=$1', [attempt.enrolment_id])).rows[0];
    if (enr?.user_id === user.id) throw forbidden('You cannot grade your own attempt');
    const feedbackEnc = i.feedback ? encrypt(i.feedback, EDU_CTX.feedback) : null;
    const outcome = attempt.pass_mark ? (i.manual_score >= parseFloat(attempt.pass_mark) ? 'pass' : 'fail') : 'pass';
    const r = (await c.query(
      'UPDATE off_edu_exam_attempts SET manual_score=$1, outcome=$2, feedback_enc=$3, graded_at=now(), graded_by=$4 WHERE id=$5 RETURNING *',
      [i.manual_score, outcome, feedbackEnc, user.id, i.id])).rows[0];
    await logOff(c, attempt.governing_body_id, 'edu_exam_attempt', i.id, 'graded', { actor: user.id, detail: { outcome } });
    if (enr) await notify(enr.user_id, 'edu_exam_graded', { outcome, score: i.manual_score });
    return plain(r);
  }),
});

cap({
  name: 'void_exam_attempt', method: 'POST', path: '/officials-education/exam-attempts/:id/void', tag: TAG,
  summary: 'Void an exam attempt (e.g. misconduct, technical error). Voided attempts do not count toward the limit.',
  input: z.object({ id, reason: text(500) }),
  handler: ({ user }, i) => tx(async (c) => {
    const attempt = await loadAttempt(i.id, c);
    if (attempt.voided_at) throw badRequest('Already voided');
    await devStaff(user, attempt.governing_body_id, { c });
    const r = (await c.query('UPDATE off_edu_exam_attempts SET voided_at=now(), voided_by=$1, voided_reason=$2 WHERE id=$3 RETURNING *', [user.id, i.reason, i.id])).rows[0];
    await logOff(c, attempt.governing_body_id, 'edu_exam_attempt', i.id, 'voided', { actor: user.id, reason: i.reason });
    return plain(r);
  }),
});

cap({
  name: 'get_exam_attempt', method: 'GET', path: '/officials-education/exam-attempts/:id', tag: TAG,
  summary: 'Get an exam attempt. Officials see their own; staff see all. Feedback decrypted for the official.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const attempt = await loadAttempt(i.id);
    const enr = (await pool.query('SELECT user_id FROM off_edu_enrolments WHERE id=$1', [attempt.enrolment_id])).rows[0];
    const isOwn = enr?.user_id === user.id;
    if (!isOwn) await devStaff(user, attempt.governing_body_id);
    const result = plain(attempt);
    if (isOwn && attempt.feedback_enc) {
      result.feedback = decrypt(attempt.feedback_enc, EDU_CTX.feedback);
      await audit(pool, user.id, 'read_exam_feedback', 'off_edu_exam_attempts', i.id);
    }
    delete result.feedback_enc;
    delete result.answers_enc;
    return result;
  },
});

cap({
  name: 'list_exam_attempts', method: 'GET', path: '/officials-education/enrolments/:id/exam-attempts', tag: TAG,
  summary: 'List all exam attempts for an enrolment.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const enr = await loadEnrolment(i.id);
    if (enr.user_id !== user.id) await devStaff(user, enr.governing_body_id);
    return many(
      `SELECT a.id, a.exam_id, x.title AS exam_title, a.attempt_number, a.auto_score, a.manual_score,
              COALESCE(a.manual_score, a.auto_score) AS final_score, a.outcome, a.started_at, a.submitted_at, a.graded_at,
              a.voided_at, a.voided_reason
         FROM off_edu_exam_attempts a JOIN off_edu_exams x ON x.id=a.exam_id
        WHERE a.enrolment_id=$1 ORDER BY x.title, a.attempt_number`,
      [i.id]);
  },
});

// ------------------------------------------------------------------ practical evaluations

cap({
  name: 'create_practical_evaluation', method: 'POST', path: '/officials-education/enrolments/:id/practical-evaluations', tag: TAG, status: 201,
  summary: 'Start a practical field evaluation for an enrolled official.',
  input: z.object({ id, rubric_id: id.optional(), scores: z.record(z.object({ score: z.number().min(0).max(10), comment: textOpt(500) })).default({}), overall_score: pct.optional(), outcome: z.enum(['competent','not_yet_competent','distinction']).optional(), evaluated_at: day, notes: textOpt(3000) }),
  handler: ({ user }, i) => tx(async (c) => {
    const enr = await loadEnrolment(i.id, c);
    await devStaff(user, enr.governing_body_id, { c });
    let rubricSnapshot = {};
    if (i.rubric_id) {
      const rub = (await c.query('SELECT * FROM off_rubrics WHERE id=$1', [i.rubric_id])).rows[0];
      if (rub) rubricSnapshot = plain(rub);
    }
    const scoresWithEnc = Object.fromEntries(Object.entries(i.scores).map(([k, v]) => [k, { score: v.score, comment_enc: v.comment ? encrypt(v.comment, EDU_CTX.notes) : null }]));
    const notesEnc = i.notes ? encrypt(i.notes, EDU_CTX.notes) : null;
    const r = (await c.query(
      `INSERT INTO off_edu_practical_evaluations(enrolment_id, rubric_id, rubric_snapshot, scores, overall_score, outcome, evaluated_by, evaluated_at, notes_enc)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [i.id, i.rubric_id ?? null, JSON.stringify(rubricSnapshot), JSON.stringify(scoresWithEnc),
       i.overall_score ?? null, i.outcome ?? null, user.id, i.evaluated_at, notesEnc])).rows[0];
    await logOff(c, enr.governing_body_id, 'edu_practical_eval', r.id, 'created', { actor: user.id });
    return plain(r);
  }),
});

cap({
  name: 'submit_practical_evaluation', method: 'POST', path: '/officials-education/practical-evaluations/:id/submit', tag: TAG,
  summary: 'Submit a practical evaluation, making it visible to the official.',
  input: z.object({ id, outcome: z.enum(['competent','not_yet_competent','distinction']), overall_score: pct.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    const ev = (await c.query('SELECT ev.*, e.governing_body_id, e.user_id FROM off_edu_practical_evaluations ev JOIN off_edu_enrolments e ON e.id=ev.enrolment_id WHERE ev.id=$1', [i.id])).rows[0];
    if (!ev) throw notFound('Evaluation');
    if (ev.status !== 'draft') throw badRequest('Already submitted');
    await devStaff(user, ev.governing_body_id, { c });
    const r = (await c.query('UPDATE off_edu_practical_evaluations SET status=$1, outcome=$2, overall_score=$3 WHERE id=$4 RETURNING *', ['submitted', i.outcome, i.overall_score ?? ev.overall_score, i.id])).rows[0];
    await logOff(c, ev.governing_body_id, 'edu_practical_eval', i.id, 'submitted', { actor: user.id, detail: { outcome: i.outcome } });
    await notify(ev.user_id, 'edu_practical_eval_submitted', { outcome: i.outcome });
    return plain(r);
  }),
});

cap({
  name: 'acknowledge_practical_evaluation', method: 'POST', path: '/officials-education/practical-evaluations/:id/acknowledge', tag: TAG,
  summary: 'Official acknowledges a practical evaluation and optionally adds a comment.',
  input: z.object({ id, comment: textOpt(2000) }),
  handler: ({ user }, i) => tx(async (c) => {
    const ev = (await c.query('SELECT ev.*, e.governing_body_id, e.user_id FROM off_edu_practical_evaluations ev JOIN off_edu_enrolments e ON e.id=ev.enrolment_id WHERE ev.id=$1', [i.id])).rows[0];
    if (!ev) throw notFound('Evaluation');
    if (ev.user_id !== user.id) throw forbidden('Not your evaluation');
    if (ev.status !== 'submitted') throw badRequest('Evaluation must be submitted before it can be acknowledged');
    const commentEnc = i.comment ? encrypt(i.comment, EDU_CTX.notes) : null;
    const r = (await c.query('UPDATE off_edu_practical_evaluations SET status=$1, acknowledged_at=now(), official_comment_enc=$2 WHERE id=$3 RETURNING *', ['acknowledged', commentEnc, i.id])).rows[0];
    await logOff(c, ev.governing_body_id, 'edu_practical_eval', i.id, 'acknowledged', { actor: user.id });
    return plain(r);
  }),
});

cap({
  name: 'list_practical_evaluations', method: 'GET', path: '/officials-education/enrolments/:id/practical-evaluations', tag: TAG,
  summary: 'List practical evaluations for an enrolment.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const enr = await loadEnrolment(i.id);
    const isOwn = enr.user_id === user.id;
    if (!isOwn) await devStaff(user, enr.governing_body_id);
    const rows = await many('SELECT * FROM off_edu_practical_evaluations WHERE enrolment_id=$1 ORDER BY evaluated_at DESC', [i.id]);
    return rows.map(r => {
      const result = { ...r };
      if (isOwn && r.notes_enc) {
        result.notes = decrypt(r.notes_enc, EDU_CTX.notes);
      }
      delete result.notes_enc;
      delete result.official_comment_enc;
      return result;
    });
  },
});

// ------------------------------------------------------------------ certificates

cap({
  name: 'get_certificate', method: 'GET', path: '/officials-education/certificates/:id', tag: TAG, auth: 'public',
  summary: 'Get a certificate with its credential details.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const cert = (await pool.query(
      `SELECT cert.*, e.user_id, e.licence_id, c.title AS course_title, c.kind, c.level, c.sport_id, s.name AS sport_name,
              cr.title AS credential_title, cr.kind AS credential_kind, cr.issued_at, cr.expires_at AS credential_expires_at,
              gb.id AS body_id, b.name AS body_name
         FROM off_edu_certificates cert
         JOIN off_edu_enrolments e ON e.id=cert.enrolment_id
         JOIN off_edu_runs r ON r.id=e.run_id
         JOIN off_edu_courses c ON c.id=r.course_id
         LEFT JOIN sports s ON s.id=c.sport_id
         JOIN credentials cr ON cr.id=cert.credential_id
         JOIN governing_bodies gb ON gb.id=c.governing_body_id
         JOIN organisations b ON b.id=gb.organisation_id
        WHERE cert.id=$1`, [i.id])).rows[0];
    if (!cert) throw notFound('Certificate');
    if (user && cert.user_id !== user.id) await devStaff(user, cert.body_id).catch(() => { if (!user) throw forbidden('Sign in to view this certificate'); });
    return plain(cert);
  },
});

cap({
  name: 'list_my_certificates', method: 'GET', path: '/officials-education/my-certificates', tag: TAG,
  summary: 'List all certificates for the current user.',
  input: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0) }),
  async handler({ user }, i) {
    return many(
      `SELECT cert.*, c.title AS course_title, c.kind, c.level, c.sport_id, s.name AS sport_name,
              cr.kind AS credential_kind, b.name AS body_name
         FROM off_edu_certificates cert
         JOIN off_edu_enrolments e ON e.id=cert.enrolment_id
         JOIN off_edu_runs r ON r.id=e.run_id
         JOIN off_edu_courses c ON c.id=r.course_id
         LEFT JOIN sports s ON s.id=c.sport_id
         JOIN credentials cr ON cr.id=cert.credential_id
         JOIN governing_bodies gb ON gb.id=c.governing_body_id
         JOIN organisations b ON b.id=gb.organisation_id
        WHERE e.user_id=$1
        ORDER BY cert.issued_at DESC LIMIT $2 OFFSET $3`,
      [user.id, i.limit, i.offset]);
  },
});

cap({
  name: 'revoke_certificate', method: 'POST', path: '/officials-education/certificates/:id/revoke', tag: TAG,
  summary: 'Revoke a certificate (body staff only). Revocation is recorded on both the certificate and the linked credential.',
  input: z.object({ id, reason: text(500) }),
  handler: ({ user }, i) => tx(async (c) => {
    const cert = (await c.query(
      'SELECT cert.*, c.governing_body_id FROM off_edu_certificates cert JOIN off_edu_enrolments e ON e.id=cert.enrolment_id JOIN off_edu_runs r ON r.id=e.run_id JOIN off_edu_courses c ON c.id=r.course_id WHERE cert.id=$1', [i.id])).rows[0];
    if (!cert) throw notFound('Certificate');
    if (cert.revoked_at) throw badRequest('Already revoked');
    await devStaff(user, cert.governing_body_id, { c });
    await c.query('UPDATE off_edu_certificates SET revoked_at=now(), revoked_by=$1, revoked_reason=$2 WHERE id=$3', [user.id, i.reason, i.id]);
    await c.query("UPDATE credentials SET revoked_at=now(), revoked_by=$1, revoked_reason=$2 WHERE id=$3", [user.id, i.reason, cert.credential_id]);
    await logOff(c, cert.governing_body_id, 'edu_certificate', i.id, 'revoked', { actor: user.id, reason: i.reason });
    return { revoked: true };
  }),
});

// ------------------------------------------------------------------ analytics

cap({
  name: 'get_edu_report', method: 'GET', path: '/officials-education/bodies/:id/edu-report', tag: TAG,
  summary: 'Education analytics report for a governing body: completion rates, pass rates, CPD awarded, by sport and level.',
  input: z.object({ id, sport_id: id.optional(), from_date: day.optional(), to_date: day.optional() }),
  handler: ({ user }, i) => tx(async (c) => {
    await devStaff(user, i.id, { c });
    const rows = await many(
      `SELECT c.id AS course_id, c.title, c.kind, c.level, c.sport_id, s.name AS sport_name, c.cpd_hours,
              COUNT(e.id) FILTER (WHERE e.status='completed') AS completions,
              COUNT(e.id) FILTER (WHERE e.status NOT IN ('withdrawn','applied')) AS total_enrolled,
              COUNT(e.id) FILTER (WHERE e.outcome IN ('pass','distinction','merit','competent')) AS passes,
              ROUND(AVG(e.final_score) FILTER (WHERE e.final_score IS NOT NULL), 1) AS avg_score,
              SUM(c.cpd_hours) FILTER (WHERE e.status='completed' AND e.outcome IN ('pass','distinction','merit','competent')) AS cpd_awarded
         FROM off_edu_courses c
         LEFT JOIN sports s ON s.id=c.sport_id
         LEFT JOIN off_edu_runs r ON r.course_id=c.id
         LEFT JOIN off_edu_enrolments e ON e.run_id=r.id AND ($3::date IS NULL OR e.completion_date >= $3) AND ($4::date IS NULL OR e.completion_date <= $4)
        WHERE c.governing_body_id=$1 AND ($2::uuid IS NULL OR c.sport_id=$2)
        GROUP BY c.id, c.title, c.kind, c.level, c.sport_id, s.name, c.cpd_hours
        ORDER BY c.level, c.title`,
      [i.id, i.sport_id ?? null, i.from_date ?? null, i.to_date ?? null]);
    const totals = rows.reduce((acc, r) => ({
      completions: acc.completions + parseInt(r.completions || 0),
      total_enrolled: acc.total_enrolled + parseInt(r.total_enrolled || 0),
      passes: acc.passes + parseInt(r.passes || 0),
      cpd_awarded: acc.cpd_awarded + parseFloat(r.cpd_awarded || 0),
    }), { completions: 0, total_enrolled: 0, passes: 0, cpd_awarded: 0 });
    return { courses: rows, totals };
  }),
});
