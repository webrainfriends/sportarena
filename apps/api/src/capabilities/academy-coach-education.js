// Academy OS P1 / #791: coach education, mentoring and TD quality assurance.
// No duplicate data: staff identity stays in org_staff_engagements; credentials are read live from badgesFor();
// methodology competencies are referenced by key (not copied); canonical coaching sessions are referenced by id.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { encrypt, decrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { opsAccess, ADMINS } from '../academy-ops.js';
import { PILLARS } from '../academy-curriculum.js';

const TAG = 'Academy coach education';
const text = (n) => z.string().trim().max(n);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a calendar date (YYYY-MM-DD)');

const MODULE_KINDS = ['induction', 'cpd', 'credential', 'recertification', 'assessment', 'workshop', 'conference', 'other'];
const EVIDENCE_KINDS = ['certificate', 'external_course', 'reflection', 'observation_ref', 'credential_ref', 'attendance', 'other'];
const ACTION_KINDS = ['cpd', 'observation', 'mentoring', 'practice', 'reflection', 'external', 'other'];
const PLAN_STATUSES = ['active', 'review', 'completed', 'withdrawn'];
const OBS_STATUSES = ['draft', 'submitted', 'released'];

/** Technical Director / owner / admin = full write access to coach education. */
async function govern(user, orgId, { write = false, c } = {}) {
  const a = await opsAccess(user, orgId, { write, c });
  if (!a.admin && !a.has('curriculum')) throw forbidden('You need curriculum access to manage coach education');
  return a;
}

/** Coach can read own records; TD/admin can read everything. */
async function coachOrGovern(user, orgId, c) {
  const a = await opsAccess(user, orgId, { c });
  if (!a.admin && !a.has('curriculum') && a.role !== 'coach') {
    throw forbidden('You do not have access to coach education in this academy');
  }
  return a;
}

async function loadModule(id, c) {
  const r = c
    ? (await c.query('SELECT * FROM academy_edu_modules WHERE id=$1', [id])).rows[0]
    : await one('SELECT * FROM academy_edu_modules WHERE id=$1', [id]);
  if (!r) throw notFound('Module');
  return r;
}

async function loadAssignment(id, c) {
  const r = c
    ? (await c.query('SELECT * FROM academy_edu_assignments WHERE id=$1', [id])).rows[0]
    : await one('SELECT * FROM academy_edu_assignments WHERE id=$1', [id]);
  if (!r) throw notFound('Assignment');
  return r;
}

async function loadCompletion(id) {
  const r = await one('SELECT * FROM academy_edu_completions WHERE id=$1', [id]);
  if (!r) throw notFound('Completion');
  return r;
}

async function loadAppeal(id) {
  const r = await one('SELECT * FROM academy_edu_appeals WHERE id=$1', [id]);
  if (!r) throw notFound('Appeal');
  return r;
}

async function loadPairing(id, c) {
  const r = c
    ? (await c.query('SELECT * FROM academy_mentor_pairings WHERE id=$1', [id])).rows[0]
    : await one('SELECT * FROM academy_mentor_pairings WHERE id=$1', [id]);
  if (!r) throw notFound('Pairing');
  return r;
}

async function loadSession(id) {
  const r = await one('SELECT * FROM academy_mentor_sessions WHERE id=$1', [id]);
  if (!r) throw notFound('Session');
  return r;
}

async function loadObservation(id, c) {
  const r = c
    ? (await c.query('SELECT * FROM academy_td_observations WHERE id=$1', [id])).rows[0]
    : await one('SELECT * FROM academy_td_observations WHERE id=$1', [id]);
  if (!r) throw notFound('Observation');
  return r;
}

async function loadPlan(id, c) {
  const r = c
    ? (await c.query('SELECT * FROM academy_coach_improvement_plans WHERE id=$1', [id])).rows[0]
    : await one('SELECT * FROM academy_coach_improvement_plans WHERE id=$1', [id]);
  if (!r) throw notFound('Plan');
  return r;
}

// ---------------------------------------------------------------- module library

cap({
  name: 'create_academy_edu_module',
  method: 'POST',
  path: '/organisations/:id/academy/edu-modules',
  tag: TAG,
  status: 201,
  summary: 'Create a CPD/education module in the academy library (Technical Director / owner / admin). Modules are assigned to coaches or cohorts; completion evidence is submitted by the coach and reviewed by the TD.',
  input: z.object({
    id,
    title: text(160).min(2),
    kind: z.enum(MODULE_KINDS).default('cpd'),
    pillar: z.enum(PILLARS).optional(),
    mandatory: z.boolean().default(false),
    cpd_hours: z.number().min(0).max(1000).optional(),
    description: text(2000).optional(),
    due_days_after_join: z.number().int().min(1).max(3650).optional(),
    recurrence_months: z.number().int().min(1).max(60).optional(),
    linked_credential_kind: text(80).optional(),
  }),
  async handler({ user }, i) {
    await govern(user, i.id, { write: true });
    const r = await one(
      `INSERT INTO academy_edu_modules(organisation_id, title, kind, pillar, mandatory, cpd_hours, description,
        due_days_after_join, recurrence_months, linked_credential_kind, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft',$11) RETURNING *`,
      [i.id, i.title, i.kind, i.pillar ?? null, i.mandatory, i.cpd_hours ?? null, i.description ?? null,
        i.due_days_after_join ?? null, i.recurrence_months ?? null, i.linked_credential_kind ?? null, user.id],
    );
    await audit(null, user.id, 'create_academy_edu_module', 'academy_edu_modules', r.id);
    return r;
  },
});

cap({
  name: 'update_academy_edu_module',
  method: 'PATCH',
  path: '/academy/edu-modules/:id',
  tag: TAG,
  summary: 'Update a CPD/education module (Technical Director / owner / admin). Send row_version from the last read to prevent concurrent overwrites.',
  input: z.object({
    id,
    row_version: z.number().int().min(1),
    title: text(160).min(2).optional(),
    kind: z.enum(MODULE_KINDS).optional(),
    pillar: z.enum(PILLARS).nullable().optional(),
    mandatory: z.boolean().optional(),
    cpd_hours: z.number().min(0).max(1000).nullable().optional(),
    description: text(2000).nullable().optional(),
    due_days_after_join: z.number().int().min(1).max(3650).nullable().optional(),
    recurrence_months: z.number().int().min(1).max(60).nullable().optional(),
    linked_credential_kind: text(80).nullable().optional(),
    status: z.enum(['draft', 'published', 'archived']).optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const m = (await c.query('SELECT * FROM academy_edu_modules WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!m) throw notFound('Module');
    await govern(user, m.organisation_id, { write: true, c });
    if (m.row_version !== i.row_version) throw conflict('Module changed since you opened it. Reload and try again.', { code: 'stale_version' });
    const fields = [], vals = [];
    const set = (col, val) => { fields.push(`${col}=$${vals.push(val)}`); };
    if (i.title !== undefined) set('title', i.title);
    if (i.kind !== undefined) set('kind', i.kind);
    if (i.pillar !== undefined) set('pillar', i.pillar);
    if (i.mandatory !== undefined) set('mandatory', i.mandatory);
    if (i.cpd_hours !== undefined) set('cpd_hours', i.cpd_hours);
    if (i.description !== undefined) set('description', i.description);
    if (i.due_days_after_join !== undefined) set('due_days_after_join', i.due_days_after_join);
    if (i.recurrence_months !== undefined) set('recurrence_months', i.recurrence_months);
    if (i.linked_credential_kind !== undefined) set('linked_credential_kind', i.linked_credential_kind);
    if (i.status !== undefined) set('status', i.status);
    if (!fields.length) throw badRequest('Nothing to update');
    set('updated_by', user.id);
    set('updated_at', new Date().toISOString());
    set('row_version', m.row_version + 1);
    const r = (await c.query(`UPDATE academy_edu_modules SET ${fields.join(',')} WHERE id=$${vals.push(i.id)} RETURNING *`, vals)).rows[0];
    await audit(null, user.id, 'update_academy_edu_module', 'academy_edu_modules', r.id);
    return r;
  }),
});

cap({
  name: 'list_academy_edu_modules',
  method: 'GET',
  path: '/organisations/:id/academy/edu-modules',
  tag: TAG,
  summary: 'List CPD/education modules for an academy. TD and admin see all; coaches see published only.',
  input: z.object({
    id,
    status: z.enum(['draft', 'published', 'archived', 'all']).default('published'),
    kind: z.enum([...MODULE_KINDS, 'all']).default('all'),
    pillar: z.enum([...PILLARS, 'all']).default('all'),
    ...page,
  }),
  async handler({ user }, i) {
    const a = await coachOrGovern(user, i.id);
    const isGovern = a.admin || a.has('curriculum');
    const statusFilter = isGovern ? (i.status === 'all' ? null : i.status) : 'published';
    const rows = await many(
      `SELECT * FROM academy_edu_modules WHERE organisation_id=$1
        AND ($2::text IS NULL OR status=$2)
        AND ($3::text IS NULL OR kind=$3)
        AND ($4::text IS NULL OR pillar=$4)
       ORDER BY mandatory DESC, title LIMIT $5 OFFSET $6`,
      [i.id, statusFilter, i.kind === 'all' ? null : i.kind, i.pillar === 'all' ? null : i.pillar, i.limit ?? 50, i.offset ?? 0],
    );
    return rows;
  },
});

cap({
  name: 'get_academy_edu_module',
  method: 'GET',
  path: '/academy/edu-modules/:id',
  tag: TAG,
  summary: 'Get a single CPD/education module.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const m = await loadModule(i.id);
    await coachOrGovern(user, m.organisation_id);
    return m;
  },
});

// ---------------------------------------------------------------- assignments

cap({
  name: 'assign_academy_edu_module',
  method: 'POST',
  path: '/academy/edu-modules/:id/assignments',
  tag: TAG,
  status: 201,
  summary: 'Assign a CPD module to an individual coach, a cohort or a role template. Notifies the coach if assigned directly.',
  input: z.object({
    id,
    coach_id: z.string().uuid().optional(),
    cohort_id: z.string().uuid().optional(),
    role_template: text(60).optional(),
    due_on: day.optional(),
    note: text(500).optional(),
  }),
  async handler({ user }, i) {
    const m = await loadModule(i.id);
    if (m.status !== 'published') throw badRequest('Only published modules can be assigned');
    const a = await govern(user, m.organisation_id, { write: true });
    if (!i.coach_id && !i.cohort_id && !i.role_template) throw badRequest('Provide at least one of coach_id, cohort_id or role_template');
    const r = await one(
      `INSERT INTO academy_edu_assignments(organisation_id, module_id, coach_id, cohort_id, role_template, due_on, assigned_by, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [m.organisation_id, m.id, i.coach_id ?? null, i.cohort_id ?? null, i.role_template ?? null, i.due_on ?? null, user.id, i.note ?? null],
    );
    await audit(null, user.id, 'assign_academy_edu_module', 'academy_edu_assignments', r.id);
    if (i.coach_id) {
      await notify(i.coach_id, 'edu_module_assigned', { module_id: m.id, assignment_id: r.id, title: m.title, due_on: i.due_on ?? null });
    }
    return r;
  },
});

cap({
  name: 'revoke_academy_edu_assignment',
  method: 'DELETE',
  path: '/academy/edu-assignments/:id',
  tag: TAG,
  summary: 'Revoke a module assignment (soft: sets status to expired). TD / admin only.',
  input: z.object({ id }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = (await c.query('SELECT * FROM academy_edu_assignments WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!a) throw notFound('Assignment');
    await govern(user, a.organisation_id, { write: true, c });
    if (['approved', 'expired'].includes(a.status)) throw badRequest('This assignment is already closed');
    const r = (await c.query(`UPDATE academy_edu_assignments SET status='expired', updated_at=now(), row_version=row_version+1 WHERE id=$1 RETURNING *`, [i.id])).rows[0];
    await audit(null, user.id, 'revoke_academy_edu_assignment', 'academy_edu_assignments', r.id);
    return r;
  }),
});

cap({
  name: 'list_academy_edu_assignments',
  method: 'GET',
  path: '/organisations/:id/academy/edu-assignments',
  tag: TAG,
  summary: 'List module assignments for an academy. Optionally filter by coach, module or status.',
  input: z.object({
    id,
    coach_id: z.string().uuid().optional(),
    module_id: z.string().uuid().optional(),
    status: z.enum([...['assigned', 'in_progress', 'submitted', 'approved', 'rejected', 'appealing', 'expired'], 'all']).default('all'),
    ...page,
  }),
  async handler({ user }, i) {
    await govern(user, i.id);
    const rows = await many(
      `SELECT a.*, m.title AS module_title, m.kind, m.cpd_hours, m.mandatory FROM academy_edu_assignments a
         JOIN academy_edu_modules m ON m.id=a.module_id
        WHERE a.organisation_id=$1
          AND ($2::uuid IS NULL OR a.coach_id=$2)
          AND ($3::uuid IS NULL OR a.module_id=$3)
          AND ($4::text IS NULL OR a.status=$4)
       ORDER BY a.assigned_at DESC LIMIT $5 OFFSET $6`,
      [i.id, i.coach_id ?? null, i.module_id ?? null, i.status === 'all' ? null : i.status, i.limit ?? 50, i.offset ?? 0],
    );
    return rows;
  },
});

cap({
  name: 'get_my_academy_edu_assignments',
  method: 'GET',
  path: '/organisations/:id/academy/my-edu-assignments',
  tag: TAG,
  summary: 'Get a coach\'s own module assignments in this academy, with completion status.',
  input: z.object({
    id,
    status: z.enum([...['assigned', 'in_progress', 'submitted', 'approved', 'rejected', 'appealing', 'expired'], 'all']).default('all'),
    ...page,
  }),
  async handler({ user }, i) {
    await coachOrGovern(user, i.id);
    const rows = await many(
      `SELECT a.*, m.title AS module_title, m.kind, m.cpd_hours, m.mandatory, m.pillar,
              c.status AS completion_status, c.id AS completion_id
         FROM academy_edu_assignments a
         JOIN academy_edu_modules m ON m.id=a.module_id
         LEFT JOIN academy_edu_completions c ON c.assignment_id=a.id AND c.status IN ('submitted','approved')
        WHERE a.organisation_id=$1 AND a.coach_id=$2
          AND ($3::text IS NULL OR a.status=$3)
        ORDER BY a.due_on NULLS LAST, m.mandatory DESC LIMIT $4 OFFSET $5`,
      [i.id, user.id, i.status === 'all' ? null : i.status, i.limit ?? 50, i.offset ?? 0],
    );
    return rows;
  },
});

// ---------------------------------------------------------------- completions

cap({
  name: 'record_academy_edu_completion',
  method: 'POST',
  path: '/academy/edu-assignments/:id/completions',
  tag: TAG,
  status: 201,
  summary: 'Submit evidence of completing a CPD module assignment. Supply idempotency_key (8–80 chars) to prevent duplicate submissions.',
  input: z.object({
    id,
    evidence_kind: z.enum(EVIDENCE_KINDS),
    evidence_ref_id: z.string().uuid().optional(),
    evidence_url: text(2000).optional(),
    evidence_note: text(1000).optional(),
    idempotency_key: text(80).min(8).optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const a = (await c.query('SELECT * FROM academy_edu_assignments WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!a) throw notFound('Assignment');
    if (a.coach_id && a.coach_id !== user.id) {
      await govern(user, a.organisation_id, { c });
    } else {
      await coachOrGovern(user, a.organisation_id, c);
    }
    if (['approved', 'expired'].includes(a.status)) throw badRequest('This assignment is already closed');
    if (i.idempotency_key) {
      const dup = (await c.query('SELECT id FROM academy_edu_completions WHERE assignment_id=$1 AND idempotency_key=$2', [i.id, i.idempotency_key])).rows[0];
      if (dup) return dup;
    }
    const r = (await c.query(
      `INSERT INTO academy_edu_completions(assignment_id, submitted_by, evidence_kind, evidence_ref_id, evidence_url, evidence_note, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [i.id, user.id, i.evidence_kind, i.evidence_ref_id ?? null, i.evidence_url ?? null, i.evidence_note ?? null, i.idempotency_key ?? null],
    )).rows[0];
    await c.query(`UPDATE academy_edu_assignments SET status='submitted', updated_at=now(), row_version=row_version+1 WHERE id=$1`, [i.id]);
    await audit(null, user.id, 'record_academy_edu_completion', 'academy_edu_completions', r.id);
    return r;
  }),
});

cap({
  name: 'review_academy_edu_completion',
  method: 'POST',
  path: '/academy/edu-completions/:id/review',
  tag: TAG,
  summary: 'Approve or reject a completion submission (Technical Director / admin). Notifies the coach.',
  input: z.object({
    id,
    decision: z.enum(['approved', 'rejected']),
    review_note: text(500).optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const comp = (await c.query('SELECT * FROM academy_edu_completions WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!comp) throw notFound('Completion');
    const a = (await c.query('SELECT * FROM academy_edu_assignments WHERE id=$1', [comp.assignment_id])).rows[0];
    await govern(user, a.organisation_id, { write: true, c });
    if (comp.status !== 'submitted') throw badRequest('This completion is not in submitted state');
    const r = (await c.query(
      `UPDATE academy_edu_completions SET status=$1, reviewed_by=$2, reviewed_at=now(), review_note=$3, updated_at=now() WHERE id=$4 RETURNING *`,
      [i.decision, user.id, i.review_note ?? null, i.id],
    )).rows[0];
    await c.query(
      `UPDATE academy_edu_assignments SET status=$1, updated_at=now(), row_version=row_version+1 WHERE id=$2`,
      [i.decision, comp.assignment_id],
    );
    await audit(null, user.id, 'review_academy_edu_completion', 'academy_edu_completions', r.id);
    if (a.coach_id) {
      await notify(a.coach_id, `edu_completion_${i.decision}`, { completion_id: r.id, assignment_id: a.id, decision: i.decision, note: i.review_note ?? null });
    }
    return r;
  }),
});

cap({
  name: 'list_academy_edu_completions',
  method: 'GET',
  path: '/organisations/:id/academy/edu-completions',
  tag: TAG,
  summary: 'List completion submissions for review. TD/admin see all; coach sees own.',
  input: z.object({
    id,
    status: z.enum(['submitted', 'approved', 'rejected', 'all']).default('submitted'),
    coach_id: z.string().uuid().optional(),
    ...page,
  }),
  async handler({ user }, i) {
    const a = await coachOrGovern(user, i.id);
    const isGovern = a.admin || a.has('curriculum');
    const coachFilter = isGovern ? (i.coach_id ?? null) : user.id;
    const rows = await many(
      `SELECT c.*, asn.module_id, asn.coach_id, m.title AS module_title, m.cpd_hours
         FROM academy_edu_completions c
         JOIN academy_edu_assignments asn ON asn.id=c.assignment_id
         JOIN academy_edu_modules m ON m.id=asn.module_id
        WHERE asn.organisation_id=$1
          AND ($2::text IS NULL OR c.status=$2)
          AND ($3::uuid IS NULL OR asn.coach_id=$3)
       ORDER BY c.created_at DESC LIMIT $4 OFFSET $5`,
      [i.id, i.status === 'all' ? null : i.status, coachFilter, i.limit ?? 50, i.offset ?? 0],
    );
    return rows;
  },
});

// ---------------------------------------------------------------- appeals

cap({
  name: 'create_academy_edu_appeal',
  method: 'POST',
  path: '/academy/edu-completions/:id/appeals',
  tag: TAG,
  status: 201,
  summary: 'Appeal a rejected completion (coach only). One open appeal per completion at a time.',
  input: z.object({
    id,
    reason: text(1000).min(10),
    evidence_note: text(1000).optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const comp = (await c.query('SELECT * FROM academy_edu_completions WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!comp) throw notFound('Completion');
    const a = (await c.query('SELECT * FROM academy_edu_assignments WHERE id=$1', [comp.assignment_id])).rows[0];
    if (a.coach_id && a.coach_id !== user.id) throw forbidden('Only the assigned coach may appeal this completion');
    if (comp.status !== 'rejected') throw badRequest('Only rejected completions can be appealed');
    const existing = (await c.query(`SELECT id FROM academy_edu_appeals WHERE completion_id=$1 AND status='pending'`, [i.id])).rows[0];
    if (existing) throw conflict('An open appeal already exists for this completion', { code: 'duplicate_appeal' });
    const r = (await c.query(
      `INSERT INTO academy_edu_appeals(completion_id, appellant_id, reason, evidence_note) VALUES ($1,$2,$3,$4) RETURNING *`,
      [i.id, user.id, i.reason, i.evidence_note ?? null],
    )).rows[0];
    await c.query(`UPDATE academy_edu_assignments SET status='appealing', updated_at=now(), row_version=row_version+1 WHERE id=$1`, [comp.assignment_id]);
    await audit(null, user.id, 'create_academy_edu_appeal', 'academy_edu_appeals', r.id);
    return r;
  }),
});

cap({
  name: 'decide_academy_edu_appeal',
  method: 'POST',
  path: '/academy/edu-appeals/:id/decision',
  tag: TAG,
  summary: 'Uphold or dismiss an appeal (Technical Director / admin). Notifies the coach.',
  input: z.object({
    id,
    decision: z.enum(['upheld', 'dismissed']),
    decision_note: text(500).optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const ap = (await c.query('SELECT * FROM academy_edu_appeals WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!ap) throw notFound('Appeal');
    const comp = (await c.query('SELECT * FROM academy_edu_completions WHERE id=$1', [ap.completion_id])).rows[0];
    const a = (await c.query('SELECT * FROM academy_edu_assignments WHERE id=$1', [comp.assignment_id])).rows[0];
    await govern(user, a.organisation_id, { write: true, c });
    if (ap.status !== 'pending') throw badRequest('This appeal is already decided');
    const r = (await c.query(
      `UPDATE academy_edu_appeals SET status=$1, decided_by=$2, decided_at=now(), decision_note=$3, updated_at=now(), row_version=row_version+1 WHERE id=$4 RETURNING *`,
      [i.decision, user.id, i.decision_note ?? null, i.id],
    )).rows[0];
    const newCompStatus = i.decision === 'upheld' ? 'approved' : 'rejected';
    const newAsnStatus = i.decision === 'upheld' ? 'approved' : 'rejected';
    await c.query(`UPDATE academy_edu_completions SET status=$1, updated_at=now() WHERE id=$2`, [newCompStatus, comp.id]);
    await c.query(`UPDATE academy_edu_assignments SET status=$1, updated_at=now(), row_version=row_version+1 WHERE id=$2`, [newAsnStatus, a.id]);
    await audit(null, user.id, 'decide_academy_edu_appeal', 'academy_edu_appeals', r.id);
    await notify(ap.appellant_id, `edu_appeal_${i.decision}`, { appeal_id: r.id, decision: i.decision, note: i.decision_note ?? null });
    return r;
  }),
});

// ---------------------------------------------------------------- mentor pairings

cap({
  name: 'create_mentor_pairing',
  method: 'POST',
  path: '/organisations/:id/academy/mentor-pairings',
  tag: TAG,
  status: 201,
  summary: 'Create a mentor–mentee pairing (TD / admin). One live pairing per mentee per academy.',
  input: z.object({
    id,
    mentor_id: z.string().uuid(),
    mentee_id: z.string().uuid(),
    goals: z.array(z.object({ key: z.string().min(1).max(60), label: text(200).min(2), status: z.enum(['pending', 'achieved', 'dropped']).default('pending') })).max(10).default([]),
    frequency_weeks: z.number().int().min(1).max(52).default(2),
    starts_on: day,
    ends_on: day.optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    await govern(user, i.id, { write: true, c });
    if (i.mentor_id === i.mentee_id) throw badRequest('Mentor and mentee must be different people');
    const dup = (await c.query(`SELECT id FROM academy_mentor_pairings WHERE organisation_id=$1 AND mentee_id=$2 AND status IN ('active','paused')`, [i.id, i.mentee_id])).rows[0];
    if (dup) throw conflict('This mentee already has an active pairing. End it before creating a new one.', { code: 'duplicate_pairing' });
    const r = (await c.query(
      `INSERT INTO academy_mentor_pairings(organisation_id, mentor_id, mentee_id, goals, frequency_weeks, starts_on, ends_on, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [i.id, i.mentor_id, i.mentee_id, JSON.stringify(i.goals), i.frequency_weeks, i.starts_on, i.ends_on ?? null, user.id],
    )).rows[0];
    await audit(null, user.id, 'create_mentor_pairing', 'academy_mentor_pairings', r.id);
    await notify(i.mentee_id, 'mentor_pairing_created', { pairing_id: r.id, mentor_id: i.mentor_id });
    return r;
  }),
});

cap({
  name: 'update_mentor_pairing',
  method: 'PATCH',
  path: '/academy/mentor-pairings/:id',
  tag: TAG,
  summary: 'Update a mentor pairing (goals, frequency, status). Send row_version.',
  input: z.object({
    id,
    row_version: z.number().int().min(1),
    goals: z.array(z.object({ key: z.string().min(1).max(60), label: text(200).min(2), status: z.enum(['pending', 'achieved', 'dropped']).default('pending') })).max(10).optional(),
    frequency_weeks: z.number().int().min(1).max(52).optional(),
    ends_on: day.nullable().optional(),
    status: z.enum(['active', 'paused', 'ended']).optional(),
    end_reason: text(300).nullable().optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const p = (await c.query('SELECT * FROM academy_mentor_pairings WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!p) throw notFound('Pairing');
    await govern(user, p.organisation_id, { write: true, c });
    if (p.row_version !== i.row_version) throw conflict('Pairing changed since you opened it. Reload and try again.', { code: 'stale_version' });
    const fields = [], vals = [];
    const set = (col, val) => { fields.push(`${col}=$${vals.push(val)}`); };
    if (i.goals !== undefined) set('goals', JSON.stringify(i.goals));
    if (i.frequency_weeks !== undefined) set('frequency_weeks', i.frequency_weeks);
    if (i.ends_on !== undefined) set('ends_on', i.ends_on);
    if (i.status !== undefined) set('status', i.status);
    if (i.end_reason !== undefined) set('end_reason', i.end_reason);
    if (!fields.length) throw badRequest('Nothing to update');
    set('updated_by', user.id);
    set('updated_at', new Date().toISOString());
    set('row_version', p.row_version + 1);
    const r = (await c.query(`UPDATE academy_mentor_pairings SET ${fields.join(',')} WHERE id=$${vals.push(i.id)} RETURNING *`, vals)).rows[0];
    await audit(null, user.id, 'update_mentor_pairing', 'academy_mentor_pairings', r.id);
    return r;
  }),
});

cap({
  name: 'list_mentor_pairings',
  method: 'GET',
  path: '/organisations/:id/academy/mentor-pairings',
  tag: TAG,
  summary: 'List mentor pairings for an academy. TD/admin see all; a coach sees their own pairings as mentor or mentee.',
  input: z.object({
    id,
    status: z.enum(['active', 'paused', 'ended', 'all']).default('active'),
    ...page,
  }),
  async handler({ user }, i) {
    const a = await coachOrGovern(user, i.id);
    const isGovern = a.admin || a.has('curriculum');
    const rows = await many(
      `SELECT p.*,
              (SELECT count(*) FROM academy_mentor_sessions s WHERE s.pairing_id=p.id AND s.status='completed') AS sessions_done,
              (SELECT max(s.scheduled_at) FROM academy_mentor_sessions s WHERE s.pairing_id=p.id AND s.status='completed') AS last_session_at,
              (SELECT min(s.scheduled_at) FROM academy_mentor_sessions s WHERE s.pairing_id=p.id AND s.status='scheduled') AS next_session_at
         FROM academy_mentor_pairings p
        WHERE p.organisation_id=$1
          AND ($2::text IS NULL OR p.status=$2)
          AND ($3::boolean = true OR p.mentor_id=$4 OR p.mentee_id=$4)
       ORDER BY p.created_at DESC LIMIT $5 OFFSET $6`,
      [i.id, i.status === 'all' ? null : i.status, isGovern, user.id, i.limit ?? 50, i.offset ?? 0],
    );
    return rows;
  },
});

cap({
  name: 'get_mentor_pairing',
  method: 'GET',
  path: '/academy/mentor-pairings/:id',
  tag: TAG,
  summary: 'Get full details of a mentor pairing including sessions summary.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const p = await loadPairing(i.id);
    const a = await coachOrGovern(user, p.organisation_id);
    const isGovern = a.admin || a.has('curriculum');
    if (!isGovern && user.id !== p.mentor_id && user.id !== p.mentee_id) {
      throw forbidden('You are not part of this mentoring pairing');
    }
    return p;
  },
});

// ---------------------------------------------------------------- mentor sessions

cap({
  name: 'schedule_mentor_session',
  method: 'POST',
  path: '/academy/mentor-pairings/:id/sessions',
  tag: TAG,
  status: 201,
  summary: 'Schedule a mentoring session for a pairing.',
  input: z.object({
    id,
    scheduled_at: z.string().datetime(),
    duration_min: z.number().int().min(10).max(480).default(60),
  }),
  async handler({ user }, i) {
    const p = await loadPairing(i.id);
    const a = await coachOrGovern(user, p.organisation_id);
    const isGovern = a.admin || a.has('curriculum');
    if (!isGovern && user.id !== p.mentor_id && user.id !== p.mentee_id) {
      throw forbidden('Only pairing participants or TD may schedule sessions');
    }
    if (p.status === 'ended') throw badRequest('This pairing has ended');
    const r = await one(
      `INSERT INTO academy_mentor_sessions(pairing_id, scheduled_at, duration_min, created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
      [i.id, i.scheduled_at, i.duration_min, user.id],
    );
    await audit(null, user.id, 'schedule_mentor_session', 'academy_mentor_sessions', r.id);
    const other = user.id === p.mentor_id ? p.mentee_id : p.mentor_id;
    await notify(other, 'mentor_session_scheduled', { session_id: r.id, pairing_id: p.id, scheduled_at: i.scheduled_at });
    return r;
  },
});

cap({
  name: 'complete_mentor_session',
  method: 'POST',
  path: '/academy/mentor-sessions/:id/complete',
  tag: TAG,
  summary: 'Mark a mentoring session complete, record agreed actions and append an encrypted private note.',
  input: z.object({
    id,
    row_version: z.number().int().min(1),
    agreed_actions: z.array(z.object({ label: text(200).min(2), due_on: day.optional(), status: z.enum(['open', 'done', 'cancelled']).default('open') })).max(20).default([]),
    note: text(5000).optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const s = (await c.query('SELECT * FROM academy_mentor_sessions WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!s) throw notFound('Session');
    const p = (await c.query('SELECT * FROM academy_mentor_pairings WHERE id=$1', [s.pairing_id])).rows[0];
    const a = await coachOrGovern(user, p.organisation_id, c);
    const isGovern = a.admin || a.has('curriculum');
    if (!isGovern && user.id !== p.mentor_id && user.id !== p.mentee_id) {
      throw forbidden('Only pairing participants or TD may complete sessions');
    }
    if (s.status === 'completed') throw badRequest('This session is already completed');
    if (s.row_version !== i.row_version) throw conflict('Session changed since you opened it. Reload and try again.', { code: 'stale_version' });
    const r = (await c.query(
      `UPDATE academy_mentor_sessions SET status='completed', agreed_actions=$1, completed_at=now(), updated_at=now(), row_version=row_version+1 WHERE id=$2 RETURNING *`,
      [JSON.stringify(i.agreed_actions), i.id],
    )).rows[0];
    if (i.note) {
      const note_enc = await encrypt(i.note);
      await c.query(`INSERT INTO academy_mentor_session_notes(session_id, author_id, note_enc) VALUES ($1,$2,$3)`, [i.id, user.id, note_enc]);
      await audit(null, user.id, 'write_mentor_session_note', 'academy_mentor_session_notes', i.id);
    }
    await audit(null, user.id, 'complete_mentor_session', 'academy_mentor_sessions', r.id);
    return r;
  }),
});

cap({
  name: 'list_mentor_sessions',
  method: 'GET',
  path: '/academy/mentor-pairings/:id/sessions',
  tag: TAG,
  summary: 'List sessions for a mentor pairing. Notes are not included; they are gated by participant check.',
  input: z.object({
    id,
    status: z.enum(['scheduled', 'completed', 'cancelled', 'no_show', 'all']).default('all'),
    ...page,
  }),
  async handler({ user }, i) {
    const p = await loadPairing(i.id);
    const a = await coachOrGovern(user, p.organisation_id);
    const isGovern = a.admin || a.has('curriculum');
    if (!isGovern && user.id !== p.mentor_id && user.id !== p.mentee_id) {
      throw forbidden('You are not part of this mentoring pairing');
    }
    const rows = await many(
      `SELECT * FROM academy_mentor_sessions WHERE pairing_id=$1 AND ($2::text IS NULL OR status=$2)
       ORDER BY scheduled_at DESC LIMIT $3 OFFSET $4`,
      [i.id, i.status === 'all' ? null : i.status, i.limit ?? 50, i.offset ?? 0],
    );
    return rows;
  },
});

// ---------------------------------------------------------------- TD quality observations

cap({
  name: 'create_td_observation',
  method: 'POST',
  path: '/organisations/:id/academy/td-observations',
  tag: TAG,
  status: 201,
  summary: 'Create a TD quality observation of a coaching session. Private notes (strengths, development) are encrypted and not visible to the coach until released.',
  input: z.object({
    id,
    coach_id: z.string().uuid(),
    session_id: z.string().uuid().optional(),
    methodology_version_id: z.string().uuid().optional(),
    rubric_id: z.string().uuid().optional(),
    pillar_ratings: z.record(z.string(), z.record(z.string(), z.number().int().min(1).max(5))).default({}),
    overall_rating: z.number().int().min(1).max(5).optional(),
    strengths: text(5000).optional(),
    development: text(5000).optional(),
    next_steps: text(2000).optional(),
  }),
  async handler({ user }, i) {
    await govern(user, i.id, { write: true });
    const strengths_enc = i.strengths ? await encrypt(i.strengths) : null;
    const development_enc = i.development ? await encrypt(i.development) : null;
    const r = await one(
      `INSERT INTO academy_td_observations(organisation_id, coach_id, session_id, methodology_version_id, rubric_id,
         pillar_ratings, overall_rating, strengths_enc, development_enc, next_steps, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [i.id, i.coach_id, i.session_id ?? null, i.methodology_version_id ?? null, i.rubric_id ?? null,
        JSON.stringify(i.pillar_ratings), i.overall_rating ?? null, strengths_enc, development_enc, i.next_steps ?? null, user.id],
    );
    await audit(null, user.id, 'create_td_observation', 'academy_td_observations', r.id);
    return { ...r, strengths_enc: undefined, development_enc: undefined };
  },
});

cap({
  name: 'update_td_observation',
  method: 'PATCH',
  path: '/academy/td-observations/:id',
  tag: TAG,
  summary: 'Update a draft TD observation. Send row_version.',
  input: z.object({
    id,
    row_version: z.number().int().min(1),
    session_id: z.string().uuid().nullable().optional(),
    methodology_version_id: z.string().uuid().nullable().optional(),
    rubric_id: z.string().uuid().nullable().optional(),
    pillar_ratings: z.record(z.string(), z.record(z.string(), z.number().int().min(1).max(5))).optional(),
    overall_rating: z.number().int().min(1).max(5).nullable().optional(),
    strengths: text(5000).nullable().optional(),
    development: text(5000).nullable().optional(),
    next_steps: text(2000).nullable().optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const o = (await c.query('SELECT * FROM academy_td_observations WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!o) throw notFound('Observation');
    await govern(user, o.organisation_id, { write: true, c });
    if (o.status === 'released') throw badRequest('Released observations cannot be edited');
    if (o.row_version !== i.row_version) throw conflict('Observation changed since you opened it. Reload and try again.', { code: 'stale_version' });
    const fields = [], vals = [];
    const set = (col, val) => { fields.push(`${col}=$${vals.push(val)}`); };
    if (i.session_id !== undefined) set('session_id', i.session_id);
    if (i.methodology_version_id !== undefined) set('methodology_version_id', i.methodology_version_id);
    if (i.rubric_id !== undefined) set('rubric_id', i.rubric_id);
    if (i.pillar_ratings !== undefined) set('pillar_ratings', JSON.stringify(i.pillar_ratings));
    if (i.overall_rating !== undefined) set('overall_rating', i.overall_rating);
    if (i.strengths !== undefined) set('strengths_enc', i.strengths !== null ? await encrypt(i.strengths) : null);
    if (i.development !== undefined) set('development_enc', i.development !== null ? await encrypt(i.development) : null);
    if (i.next_steps !== undefined) set('next_steps', i.next_steps);
    if (!fields.length) throw badRequest('Nothing to update');
    set('updated_by', user.id);
    set('updated_at', new Date().toISOString());
    set('row_version', o.row_version + 1);
    const r = (await c.query(`UPDATE academy_td_observations SET ${fields.join(',')} WHERE id=$${vals.push(i.id)} RETURNING *`, vals)).rows[0];
    await audit(null, user.id, 'update_td_observation', 'academy_td_observations', r.id);
    return { ...r, strengths_enc: undefined, development_enc: undefined };
  }),
});

cap({
  name: 'submit_td_observation',
  method: 'POST',
  path: '/academy/td-observations/:id/submit',
  tag: TAG,
  summary: 'Move a draft observation to submitted state (ready for release review).',
  input: z.object({ id, row_version: z.number().int().min(1) }),
  handler: ({ user }, i) => tx(async (c) => {
    const o = (await c.query('SELECT * FROM academy_td_observations WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!o) throw notFound('Observation');
    await govern(user, o.organisation_id, { write: true, c });
    if (o.status !== 'draft') throw badRequest('Only draft observations can be submitted');
    if (o.row_version !== i.row_version) throw conflict('Observation changed since you opened it.', { code: 'stale_version' });
    const r = (await c.query(
      `UPDATE academy_td_observations SET status='submitted', updated_by=$1, updated_at=now(), row_version=row_version+1 WHERE id=$2 RETURNING *`,
      [user.id, i.id],
    )).rows[0];
    await audit(null, user.id, 'submit_td_observation', 'academy_td_observations', r.id);
    return { ...r, strengths_enc: undefined, development_enc: undefined };
  }),
});

cap({
  name: 'release_td_observation',
  method: 'POST',
  path: '/academy/td-observations/:id/release',
  tag: TAG,
  summary: 'Release a TD observation to the coach. The coach can read private notes and overall rating only after release. Notifies the coach.',
  input: z.object({ id, row_version: z.number().int().min(1) }),
  handler: ({ user }, i) => tx(async (c) => {
    const o = (await c.query('SELECT * FROM academy_td_observations WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!o) throw notFound('Observation');
    await govern(user, o.organisation_id, { write: true, c });
    if (o.status === 'released') throw badRequest('Already released');
    if (o.row_version !== i.row_version) throw conflict('Observation changed since you opened it.', { code: 'stale_version' });
    const r = (await c.query(
      `UPDATE academy_td_observations SET status='released', released_at=now(), released_by=$1, updated_by=$1, updated_at=now(), row_version=row_version+1 WHERE id=$2 RETURNING *`,
      [user.id, i.id],
    )).rows[0];
    await audit(null, user.id, 'release_td_observation', 'academy_td_observations', r.id);
    await notify(o.coach_id, 'td_observation_released', { observation_id: r.id, overall_rating: r.overall_rating });
    return { ...r, strengths_enc: undefined, development_enc: undefined };
  }),
});

cap({
  name: 'list_td_observations',
  method: 'GET',
  path: '/organisations/:id/academy/td-observations',
  tag: TAG,
  summary: 'List TD observations. TD/admin see all; coaches see only released observations for themselves.',
  input: z.object({
    id,
    coach_id: z.string().uuid().optional(),
    status: z.enum([...OBS_STATUSES, 'all']).default('all'),
    ...page,
  }),
  async handler({ user }, i) {
    const a = await coachOrGovern(user, i.id);
    const isGovern = a.admin || a.has('curriculum');
    const rows = await many(
      `SELECT id, organisation_id, coach_id, session_id, methodology_version_id, overall_rating, pillar_ratings,
              next_steps, status, released_at, created_by, created_at, row_version
         FROM academy_td_observations
        WHERE organisation_id=$1
          AND ($2::text IS NULL OR status=$2)
          AND ($3::boolean = true OR (coach_id=$4 AND status='released'))
          AND ($5::uuid IS NULL OR coach_id=$5)
       ORDER BY created_at DESC LIMIT $6 OFFSET $7`,
      [i.id, i.status === 'all' ? null : i.status, isGovern, user.id, isGovern ? (i.coach_id ?? null) : null, i.limit ?? 50, i.offset ?? 0],
    );
    return rows;
  },
});

cap({
  name: 'get_td_observation',
  method: 'GET',
  path: '/academy/td-observations/:id',
  tag: TAG,
  summary: 'Get a TD observation. Private notes (strengths_enc, development_enc) are decrypted for TD/admin only and audit-logged on each access.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const o = await loadObservation(i.id);
    const a = await coachOrGovern(user, o.organisation_id);
    const isGovern = a.admin || a.has('curriculum');
    if (!isGovern && user.id !== o.coach_id) throw forbidden('You cannot access this observation');
    if (!isGovern && o.status !== 'released') throw forbidden('This observation has not been released to you yet');
    const result = { ...o };
    if (isGovern) {
      if (o.strengths_enc) {
        result.strengths = await decrypt(o.strengths_enc);
        await audit(null, user.id, 'decrypt_obs_strengths', 'academy_td_observations', o.id);
      }
      if (o.development_enc) {
        result.development = await decrypt(o.development_enc);
        await audit(null, user.id, 'decrypt_obs_development', 'academy_td_observations', o.id);
      }
    }
    delete result.strengths_enc;
    delete result.development_enc;
    return result;
  },
});

// ---------------------------------------------------------------- improvement plans

cap({
  name: 'create_coach_improvement_plan',
  method: 'POST',
  path: '/organisations/:id/academy/improvement-plans',
  tag: TAG,
  status: 201,
  summary: 'Create a coach improvement plan, optionally linked to a TD observation.',
  input: z.object({
    id,
    coach_id: z.string().uuid(),
    observation_id: z.string().uuid().optional(),
    title: text(200).min(2),
    focus_pillars: z.array(z.enum(PILLARS)).max(5).default([]),
    summary: text(2000).optional(),
    starts_on: day,
    review_on: day.optional(),
    ends_on: day.optional(),
  }),
  async handler({ user }, i) {
    await govern(user, i.id, { write: true });
    if (i.observation_id) {
      const obs = await one('SELECT id, organisation_id FROM academy_td_observations WHERE id=$1', [i.observation_id]);
      if (!obs || obs.organisation_id !== i.id) throw badRequest('Observation not found in this academy');
    }
    const r = await one(
      `INSERT INTO academy_coach_improvement_plans(organisation_id, coach_id, observation_id, title, focus_pillars, summary, starts_on, review_on, ends_on, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [i.id, i.coach_id, i.observation_id ?? null, i.title, i.focus_pillars, i.summary ?? null, i.starts_on, i.review_on ?? null, i.ends_on ?? null, user.id],
    );
    await audit(null, user.id, 'create_coach_improvement_plan', 'academy_coach_improvement_plans', r.id);
    await notify(i.coach_id, 'improvement_plan_created', { plan_id: r.id, title: i.title });
    return r;
  },
});

cap({
  name: 'update_coach_improvement_plan',
  method: 'PATCH',
  path: '/academy/improvement-plans/:id',
  tag: TAG,
  summary: 'Update a coach improvement plan header. Send row_version.',
  input: z.object({
    id,
    row_version: z.number().int().min(1),
    title: text(200).min(2).optional(),
    focus_pillars: z.array(z.enum(PILLARS)).max(5).optional(),
    summary: text(2000).nullable().optional(),
    review_on: day.nullable().optional(),
    ends_on: day.nullable().optional(),
    status: z.enum(PLAN_STATUSES).optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const p = (await c.query('SELECT * FROM academy_coach_improvement_plans WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!p) throw notFound('Plan');
    await govern(user, p.organisation_id, { write: true, c });
    if (p.row_version !== i.row_version) throw conflict('Plan changed since you opened it.', { code: 'stale_version' });
    const fields = [], vals = [];
    const set = (col, val) => { fields.push(`${col}=$${vals.push(val)}`); };
    if (i.title !== undefined) set('title', i.title);
    if (i.focus_pillars !== undefined) set('focus_pillars', i.focus_pillars);
    if (i.summary !== undefined) set('summary', i.summary);
    if (i.review_on !== undefined) set('review_on', i.review_on);
    if (i.ends_on !== undefined) set('ends_on', i.ends_on);
    if (i.status !== undefined) {
      set('status', i.status);
      if (i.status === 'completed') set('completed_at', new Date().toISOString());
    }
    if (!fields.length) throw badRequest('Nothing to update');
    set('updated_by', user.id);
    set('updated_at', new Date().toISOString());
    set('row_version', p.row_version + 1);
    const r = (await c.query(`UPDATE academy_coach_improvement_plans SET ${fields.join(',')} WHERE id=$${vals.push(i.id)} RETURNING *`, vals)).rows[0];
    await audit(null, user.id, 'update_coach_improvement_plan', 'academy_coach_improvement_plans', r.id);
    return r;
  }),
});

cap({
  name: 'add_improvement_action',
  method: 'POST',
  path: '/academy/improvement-plans/:id/actions',
  tag: TAG,
  status: 201,
  summary: 'Add an action item to a coach improvement plan.',
  input: z.object({
    id,
    title: text(200).min(2),
    description: text(1000).optional(),
    kind: z.enum(ACTION_KINDS).default('cpd'),
    module_id: z.string().uuid().optional(),
    due_on: day.optional(),
    owner_id: z.string().uuid().optional(),
  }),
  async handler({ user }, i) {
    const p = await loadPlan(i.id);
    await govern(user, p.organisation_id, { write: true });
    if (['completed', 'withdrawn'].includes(p.status)) throw badRequest('Cannot add actions to a closed plan');
    const r = await one(
      `INSERT INTO academy_coach_improvement_actions(plan_id, title, description, kind, module_id, due_on, owner_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [i.id, i.title, i.description ?? null, i.kind, i.module_id ?? null, i.due_on ?? null, i.owner_id ?? null, user.id],
    );
    await audit(null, user.id, 'add_improvement_action', 'academy_coach_improvement_actions', r.id);
    return r;
  },
});

cap({
  name: 'update_improvement_action',
  method: 'PATCH',
  path: '/academy/improvement-actions/:id',
  tag: TAG,
  summary: 'Update an improvement plan action item (progress, evidence, status). Send row_version.',
  input: z.object({
    id,
    row_version: z.number().int().min(1),
    title: text(200).min(2).optional(),
    description: text(1000).nullable().optional(),
    due_on: day.nullable().optional(),
    status: z.enum(['open', 'in_progress', 'done', 'cancelled']).optional(),
    evidence: text(500).nullable().optional(),
    owner_id: z.string().uuid().nullable().optional(),
  }),
  handler: ({ user }, i) => tx(async (c) => {
    const act = (await c.query('SELECT * FROM academy_coach_improvement_actions WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
    if (!act) throw notFound('Action');
    const p = (await c.query('SELECT * FROM academy_coach_improvement_plans WHERE id=$1', [act.plan_id])).rows[0];
    await coachOrGovern(user, p.organisation_id, c);
    if (act.row_version !== i.row_version) throw conflict('Action changed since you opened it.', { code: 'stale_version' });
    const fields = [], vals = [];
    const set = (col, val) => { fields.push(`${col}=$${vals.push(val)}`); };
    if (i.title !== undefined) set('title', i.title);
    if (i.description !== undefined) set('description', i.description);
    if (i.due_on !== undefined) set('due_on', i.due_on);
    if (i.status !== undefined) {
      set('status', i.status);
      if (i.status === 'done') set('done_at', new Date().toISOString());
    }
    if (i.evidence !== undefined) set('evidence', i.evidence);
    if (i.owner_id !== undefined) set('owner_id', i.owner_id);
    if (!fields.length) throw badRequest('Nothing to update');
    set('updated_at', new Date().toISOString());
    set('row_version', act.row_version + 1);
    const r = (await c.query(`UPDATE academy_coach_improvement_actions SET ${fields.join(',')} WHERE id=$${vals.push(i.id)} RETURNING *`, vals)).rows[0];
    await audit(null, user.id, 'update_improvement_action', 'academy_coach_improvement_actions', r.id);
    return r;
  }),
});

cap({
  name: 'list_improvement_plans',
  method: 'GET',
  path: '/organisations/:id/academy/improvement-plans',
  tag: TAG,
  summary: 'List coach improvement plans. TD/admin see all; coaches see their own.',
  input: z.object({
    id,
    coach_id: z.string().uuid().optional(),
    status: z.enum([...PLAN_STATUSES, 'all']).default('active'),
    ...page,
  }),
  async handler({ user }, i) {
    const a = await coachOrGovern(user, i.id);
    const isGovern = a.admin || a.has('curriculum');
    const rows = await many(
      `SELECT p.*,
              (SELECT count(*) FROM academy_coach_improvement_actions act WHERE act.plan_id=p.id AND act.status='open') AS open_actions,
              (SELECT count(*) FROM academy_coach_improvement_actions act WHERE act.plan_id=p.id AND act.status='done') AS done_actions
         FROM academy_coach_improvement_plans p
        WHERE p.organisation_id=$1
          AND ($2::text IS NULL OR p.status=$2)
          AND ($3::boolean = true OR p.coach_id=$4)
          AND ($5::uuid IS NULL OR p.coach_id=$5)
       ORDER BY p.starts_on DESC LIMIT $6 OFFSET $7`,
      [i.id, i.status === 'all' ? null : i.status, isGovern, user.id, isGovern ? (i.coach_id ?? null) : null, i.limit ?? 50, i.offset ?? 0],
    );
    return rows;
  },
});

cap({
  name: 'get_improvement_plan',
  method: 'GET',
  path: '/academy/improvement-plans/:id',
  tag: TAG,
  summary: 'Get a coach improvement plan with all its actions.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const p = await loadPlan(i.id);
    const a = await coachOrGovern(user, p.organisation_id);
    const isGovern = a.admin || a.has('curriculum');
    if (!isGovern && user.id !== p.coach_id) throw forbidden('You cannot access this improvement plan');
    const actions = await many('SELECT * FROM academy_coach_improvement_actions WHERE plan_id=$1 ORDER BY due_on NULLS LAST, created_at', [p.id]);
    return { ...p, actions };
  },
});

// ---------------------------------------------------------------- compliance reports

cap({
  name: 'get_academy_coach_edu_report',
  method: 'GET',
  path: '/organisations/:id/academy/coach-edu-report',
  tag: TAG,
  summary: 'Compliance summary: module completion rates, CPD hours, observation counts and improvement plan status per coach/cohort. Auditors see counts only; private HR notes are never included.',
  input: z.object({
    id,
    group_by: z.enum(['coach', 'cohort']).default('coach'),
  }),
  async handler({ user }, i) {
    const a = await coachOrGovern(user, i.id);
    if (!a.admin && !a.has('curriculum') && a.role !== 'auditor') {
      throw forbidden('You need curriculum or auditor access to view the compliance report');
    }
    const moduleStats = await many(
      `SELECT asn.coach_id,
              count(*) FILTER (WHERE m.mandatory) AS mandatory_total,
              count(*) FILTER (WHERE m.mandatory AND asn.status='approved') AS mandatory_done,
              count(*) FILTER (WHERE NOT m.mandatory) AS optional_total,
              count(*) FILTER (WHERE NOT m.mandatory AND asn.status='approved') AS optional_done,
              coalesce(sum(m.cpd_hours) FILTER (WHERE asn.status='approved'), 0) AS cpd_hours_earned,
              count(*) FILTER (WHERE asn.status IN ('assigned','in_progress') AND asn.due_on < current_date) AS overdue
         FROM academy_edu_assignments asn
         JOIN academy_edu_modules m ON m.id=asn.module_id
        WHERE asn.organisation_id=$1 AND asn.coach_id IS NOT NULL
        GROUP BY asn.coach_id`,
      [i.id],
    );
    const obsStats = await many(
      `SELECT coach_id,
              count(*) AS total_observations,
              count(*) FILTER (WHERE status='released') AS released,
              round(avg(overall_rating) FILTER (WHERE overall_rating IS NOT NULL), 1) AS avg_rating
         FROM academy_td_observations WHERE organisation_id=$1 GROUP BY coach_id`,
      [i.id],
    );
    const planStats = await many(
      `SELECT coach_id,
              count(*) FILTER (WHERE status='active') AS active_plans,
              count(*) FILTER (WHERE status='completed') AS completed_plans
         FROM academy_coach_improvement_plans WHERE organisation_id=$1 GROUP BY coach_id`,
      [i.id],
    );
    return { generated_at: new Date().toISOString(), module_stats: moduleStats, observation_stats: obsStats, plan_stats: planStats };
  },
});

cap({
  name: 'export_academy_coach_edu_csv',
  method: 'GET',
  path: '/organisations/:id/academy/coach-edu-report/export',
  tag: TAG,
  summary: 'Export coach CPD compliance as CSV. Audit-logged. HR/private notes are never included.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const a = await govern(user, i.id);
    await audit(null, user.id, 'export_academy_coach_edu_csv', 'organisations', i.id);
    const rows = await many(
      `SELECT u.handle, u.display_name,
              count(*) FILTER (WHERE m.mandatory) AS mandatory_total,
              count(*) FILTER (WHERE m.mandatory AND asn.status='approved') AS mandatory_done,
              coalesce(sum(m.cpd_hours) FILTER (WHERE asn.status='approved'), 0) AS cpd_hours_earned,
              count(*) FILTER (WHERE asn.status IN ('assigned','in_progress') AND asn.due_on < current_date) AS overdue,
              count(DISTINCT obs.id) AS observations,
              count(DISTINCT pl.id) FILTER (WHERE pl.status='active') AS active_plans
         FROM academy_edu_assignments asn
         JOIN academy_edu_modules m ON m.id=asn.module_id
         JOIN users u ON u.id=asn.coach_id
         LEFT JOIN academy_td_observations obs ON obs.coach_id=asn.coach_id AND obs.organisation_id=$1
         LEFT JOIN academy_coach_improvement_plans pl ON pl.coach_id=asn.coach_id AND pl.organisation_id=$1
        WHERE asn.organisation_id=$1 AND asn.coach_id IS NOT NULL
        GROUP BY u.id, u.handle, u.display_name
        ORDER BY u.display_name`,
      [i.id],
    );
    const header = 'handle,name,mandatory_total,mandatory_done,cpd_hours_earned,overdue,observations,active_plans\n';
    const csv = header + rows.map((r) => [r.handle, r.display_name, r.mandatory_total, r.mandatory_done, r.cpd_hours_earned, r.overdue, r.observations, r.active_plans].join(',')).join('\n');
    return { csv };
  },
});
