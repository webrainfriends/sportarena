// Physio rehab tracking (the physio's counterpart of the coaching journal): measured outcomes over time, rehab goals, the patient's
// home-exercise log, and the patient's own progress view. Session notes are the existing clinical encounters (one place for notes).
// Same gates as treatment plans: a current verified physio/doctor credential + the patient's active FULL consent, rechecked inside the
// writing transaction. The patient always keeps access to what concerns them. Nothing is deleted: a wrong reading is voided with a reason,
// a goal is closed, adherence entries are append-only.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { decrypt, encrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { lockCredential, requireVerifiedProvider } from '../clinical-access.js';
import { hasGrant } from './medical.js';
import { ACCESS, GOAL_SQL, MEASURES, MEASURE_KEYS, REGIONS, adherenceFor, addDays, buildSeries, ctx, loadOutcomes, shapeGoal, today, ymd } from '../physio.js';

const TAG = 'Physio tracking';
const PROVIDER = ['physio', 'doctor'];
const text = (n) => z.string().trim().max(n);
const day = z.string().date();
const region = z.enum(REGIONS), side = z.enum(['left', 'right', 'both']), measure = z.enum(MEASURE_KEYS);

/** Verified credential and active full consent for this patient, before touching anything. */
async function providerGate(user, patientId, action) {
  if (patientId === user.id) throw badRequest('You cannot record clinical tracking for yourself');
  const cred = await requireVerifiedProvider(user.id, { action, athleteId: patientId, types: PROVIDER });
  if (!(await hasGrant(patientId, user.id))) throw forbidden('The patient has not granted you access');
  return cred;
}
/** Re-check under lock inside the write's transaction: a revocation that committed first blocks the write. */
export async function lockGate(c, cred, patientId, providerId) {
  await lockCredential(c, cred);
  if (!(await c.query("SELECT 1 FROM medical_grants WHERE athlete_id=$1 AND provider_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AND scope='full' FOR SHARE", [patientId, providerId])).rows[0]) throw forbidden('The patient has not granted you access');
}
export { providerGate };

const ownPlan = async (c, planId, providerId, patientId) => {
  const p = (await c.query('SELECT id, status FROM treatment_plans WHERE id=$1 AND provider_id=$2 AND patient_id=$3', [planId, providerId, patientId])).rows[0];
  if (!p) throw notFound('Treatment plan');
  return p;
};

// ------------------------------------------------------------------ outcomes
cap({
  name: 'record_physio_outcome', credential: true, method: 'POST', path: '/physio/outcomes', tag: TAG, auth: PROVIDER, status: 201,
  summary: 'Physio/doctor: record a measured reading for a patient who granted full access: pain (0-10), range of motion (degrees), strength (kg), function score (0-100), single-leg balance (seconds) or swelling (cm). Measures that depend on the joint need a body region. Optionally link the reading to a treatment plan or the session note it was taken at. Readings are never edited: void a wrong one with a reason and record again.',
  input: z.object({ patient_id: id, measure, body_region: region.optional(), side: side.optional(), value: z.number().finite(), measured_at: z.string().datetime({ offset: true }).optional(), plan_id: id.optional(), encounter_id: id.optional(), note: text(500).optional() }),
  async handler({ user }, i) {
    const def = MEASURES[i.measure];
    if (i.value < def.min || i.value > def.max) throw badRequest(`${def.label} must be between ${def.min} and ${def.max} ${def.unit}`);
    if (def.site && !i.body_region) throw badRequest(`${def.label} needs a body region`);
    if (i.measured_at && new Date(i.measured_at) > new Date(Date.now() + 5 * 60_000)) throw badRequest('A reading cannot be dated in the future');
    const cred = await providerGate(user, i.patient_id, 'record_physio_outcome');
    const r = await tx(async (c) => {
      await lockGate(c, cred, i.patient_id, user.id);
      if (i.plan_id) await ownPlan(c, i.plan_id, user.id, i.patient_id);
      if (i.encounter_id && !(await c.query('SELECT 1 FROM clinical_encounters WHERE id=$1 AND provider_id=$2 AND athlete_id=$3', [i.encounter_id, user.id, i.patient_id])).rows[0]) throw notFound('Session note');
      return (await c.query(
        'INSERT INTO physio_outcomes(patient_id, provider_id, plan_id, encounter_id, measure, body_region, side, value, measured_at, note_enc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::timestamptz, now()),$10) RETURNING id, patient_id, measure, body_region, side, value, measured_at, plan_id, encounter_id, created_at',
        [i.patient_id, user.id, i.plan_id ?? null, i.encounter_id ?? null, i.measure, i.body_region ?? null, i.side ?? null, i.value, i.measured_at ?? null, encrypt(i.note, ctx.outcomeNote)])).rows[0];
    });
    await audit(null, user.id, 'write_clinical', 'physio_outcomes', r.id);
    return { ...r, value: Number(r.value), unit: def.unit };
  },
});

cap({
  name: 'void_physio_outcome', credential: true, method: 'POST', path: '/physio/outcomes/:id/void', tag: TAG, auth: PROVIDER,
  summary: 'Physio/doctor: withdraw a reading you recorded (wrong patient, typo) with a reason. It stops counting towards series and goals but is kept for audit and cannot be reopened.',
  input: z.object({ id, reason: text(500).min(1) }),
  async handler({ user }, i) {
    const o = await one('SELECT patient_id, provider_id FROM physio_outcomes WHERE id=$1', [i.id]);
    if (!o || o.provider_id !== user.id) throw notFound('Reading');
    const cred = await providerGate(user, o.patient_id, 'void_physio_outcome');
    const r = await tx(async (c) => {
      await lockGate(c, cred, o.patient_id, user.id);
      const row = (await c.query('SELECT voided_at FROM physio_outcomes WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (row.voided_at) throw conflict('Already voided');
      return (await c.query('UPDATE physio_outcomes SET voided_at=now(), voided_by=$2, void_reason_enc=$3 WHERE id=$1 RETURNING id, voided_at', [i.id, user.id, encrypt(i.reason, ctx.outcomeVoid)])).rows[0];
    });
    await audit(null, user.id, 'void_clinical', 'physio_outcomes', r.id);
    return r;
  },
});

// ------------------------------------------------------------------ goals
const goalBody = {
  title: text(300).min(2), plan_id: id.optional(), measure: measure.optional(), body_region: region.optional(), side: side.optional(),
  baseline: z.number().finite().optional(), target: z.number().finite().optional(), target_date: day.optional(), shared: z.boolean().default(true).describe('the patient sees shared goals; unshared ones stay with you'),
};
const goalFields = z.object({ patient_id: id, ...goalBody });

cap({
  name: 'create_physio_goal', credential: true, method: 'POST', path: '/physio/goals', tag: TAG, auth: PROVIDER, status: 201,
  summary: 'Physio/doctor: set a rehab goal for a patient who granted full access. A goal can be a plain statement ("walk 5 km pain-free") or measured: give a measure with its baseline and target and progress is worked out from the readings you record afterwards. Optionally attach it to a treatment plan and a target date. Goals are shared with the patient unless you switch that off.',
  input: goalFields,
  async handler({ user }, i) {
    if (i.measure) {
      const def = MEASURES[i.measure];
      if (i.baseline == null || i.target == null) throw badRequest('A measured goal needs a baseline and a target');
      for (const v of [i.baseline, i.target]) if (v < def.min || v > def.max) throw badRequest(`${def.label} values must be between ${def.min} and ${def.max} ${def.unit}`);
      if (def.site && !i.body_region) throw badRequest(`${def.label} needs a body region`);
    } else if (i.baseline != null || i.target != null || i.body_region || i.side) throw badRequest('Choose a measure to set a baseline and target');
    if (i.target_date && i.target_date < today()) throw badRequest('The target date is in the past');
    const cred = await providerGate(user, i.patient_id, 'create_physio_goal');
    const g = await tx(async (c) => {
      await lockGate(c, cred, i.patient_id, user.id);
      if (i.plan_id) await ownPlan(c, i.plan_id, user.id, i.patient_id);
      return (await c.query('INSERT INTO physio_goals(patient_id, provider_id, plan_id, title_enc, measure, body_region, side, baseline, target, target_date, shared) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id',
        [i.patient_id, user.id, i.plan_id ?? null, encrypt(i.title, ctx.goalTitle), i.measure ?? null, i.body_region ?? null, i.side ?? null, i.baseline ?? null, i.target ?? null, i.target_date ?? null, i.shared])).rows[0];
    });
    await audit(null, user.id, 'write_clinical', 'physio_goals', g.id);
    return shapeGoal(await one(`${GOAL_SQL} WHERE g.id=$1`, [g.id]), { forProvider: true });
  },
});

cap({
  name: 'update_physio_goal', credential: true, method: 'PATCH', path: '/physio/goals/:id', tag: TAG, auth: PROVIDER,
  summary: 'Physio/doctor: edit an open goal (wording, target, date, whether the patient sees it) or close it as achieved, not met or discontinued with an optional note. Send the `row_version` you loaded: a stale version is refused (409). A closed goal stays as a record; set a new goal instead of reopening it.',
  input: z.object({ id, row_version: z.number().int().min(1), title: text(300).min(2).optional(), target: z.number().finite().optional(), target_date: day.nullable().optional(), shared: z.boolean().optional(), status: z.enum(['achieved', 'not_met', 'discontinued']).optional(), closing_note: text(1000).optional() }),
  async handler({ user }, i) {
    const g = await one('SELECT patient_id, provider_id FROM physio_goals WHERE id=$1', [i.id]);
    if (!g || g.provider_id !== user.id) throw notFound('Goal');
    const cred = await providerGate(user, g.patient_id, 'update_physio_goal');
    await tx(async (c) => {
      await lockGate(c, cred, g.patient_id, user.id);
      const row = (await c.query('SELECT status, row_version, measure FROM physio_goals WHERE id=$1 FOR UPDATE', [i.id])).rows[0];
      if (row.status !== 'active') throw conflict(`This goal is ${row.status.replace('_', ' ')}; set a new goal instead`);
      if (row.row_version !== i.row_version) throw conflict('This goal was changed since you loaded it; reload and try again');
      if (i.target !== undefined && !row.measure) throw badRequest('Only a measured goal has a target');
      if (i.target !== undefined && (i.target < MEASURES[row.measure].min || i.target > MEASURES[row.measure].max)) throw badRequest('Target is outside the range for this measure');
      await c.query(
        `UPDATE physio_goals SET row_version=row_version+1, updated_at=now(), title_enc=COALESCE($2,title_enc), target=COALESCE($3,target), target_date=CASE WHEN $4::boolean THEN $5::date ELSE target_date END, shared=COALESCE($6,shared),
                status=COALESCE($7,status), closed_at=CASE WHEN $7::text IS NULL THEN NULL ELSE now() END, closing_note_enc=COALESCE($8,closing_note_enc) WHERE id=$1`,
        [i.id, i.title ? encrypt(i.title, ctx.goalTitle) : null, i.target ?? null, i.target_date !== undefined, i.target_date ?? null, i.shared ?? null, i.status ?? null, i.closing_note ? encrypt(i.closing_note, ctx.goalClosing) : null]);
    });
    await audit(null, user.id, 'write_clinical', 'physio_goals', i.id);
    return shapeGoal(await one(`${GOAL_SQL} WHERE g.id=$1`, [i.id]), { forProvider: true });
  },
});

// ------------------------------------------------------------------ home-exercise log (patient)
cap({
  name: 'log_plan_adherence', method: 'POST', path: '/treatment-plans/:id/adherence', tag: TAG,
  summary: 'Patient: log what you did of your published exercise plan on a day (done, partly done or skipped), with optional pain (0-10) and effort (0-10) and a note. Logging the same day again adds a newer entry that replaces the earlier one in the totals; nothing is deleted. Your clinician sees it when they open your file: it is not monitored in real time.',
  input: z.object({ id, done_on: day.optional(), status: z.enum(['done', 'partial', 'skipped']), pain: z.number().int().min(0).max(10).optional(), effort: z.number().int().min(0).max(10).optional(), note: text(500).optional() }),
  async handler({ user }, i) {
    const t = today(), on = i.done_on ?? t;
    if (on > addDays(t, 1)) throw badRequest('You cannot log a day in the future');
    if (on < addDays(t, -14)) throw badRequest('You can log up to two weeks back');
    const p = await one("SELECT p.id, p.status, (SELECT v.version FROM treatment_plan_versions v WHERE v.plan_id=p.id AND v.status='published') AS version FROM treatment_plans p WHERE p.id=$1 AND p.patient_id=$2", [i.id, user.id]);
    if (!p || p.version == null) throw notFound('Published plan');
    if (p.status !== 'active') throw conflict(`This plan is ${p.status}, so no new exercise can be logged`);
    const r = await one('INSERT INTO treatment_plan_adherence(plan_id, patient_id, version_no, done_on, status, pain, effort, note_enc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, plan_id, version_no, done_on, status, pain, effort, created_at',
      [i.id, user.id, p.version, on, i.status, i.pain ?? null, i.effort ?? null, encrypt(i.note, ctx.adherenceNote)]);
    return r;
  },
});

/** Latest entry per day for a plan, newest first. */
async function adherenceDays(planId, from, to) {
  const rows = await many('SELECT DISTINCT ON (done_on) id, done_on, status, pain, effort, note_enc, version_no, created_at FROM treatment_plan_adherence WHERE plan_id=$1 AND done_on BETWEEN $2::date AND $3::date ORDER BY done_on DESC, created_at DESC', [planId, from, to]);
  return rows.map(({ note_enc, ...r }) => ({ ...r, done_on: ymd(r.done_on), note: note_enc ? decrypt(note_enc, ctx.adherenceNote) : null }));
}

cap({
  name: 'get_plan_adherence', credential: true, method: 'GET', path: '/treatment-plans/:id/adherence', tag: TAG,
  summary: 'The home-exercise log of a treatment plan for a period (default last 28 days, max 366): a summary against the days a week the plan asks for, and one entry per day. The patient sees their own; the prescribing provider needs a current credential and consent. Reads are audit-logged.',
  input: z.object({ id, from: day.optional(), to: day.optional() }),
  async handler({ user }, i) {
    const plan = await one('SELECT id, patient_id, provider_id, title, status FROM treatment_plans WHERE id=$1', [i.id]);
    if (!plan) throw notFound('Treatment plan');
    if (plan.patient_id !== user.id) {
      if (plan.provider_id !== user.id) throw notFound('Treatment plan');
      await providerGate(user, plan.patient_id, 'get_plan_adherence');
    }
    const to = i.to ?? today(), from = i.from ?? addDays(to, -27);
    if (to < from) throw badRequest('to is before from');
    if (new Date(to) - new Date(from) > 366 * 864e5) throw badRequest('Choose a period of at most a year');
    await audit(null, user.id, 'read_clinical', 'treatment_plan_adherence', plan.id);
    return { plan_id: plan.id, title: plan.title, status: plan.status, summary: (await adherenceFor([plan.id], from, to)).get(plan.id), days: await adherenceDays(plan.id, from, to) };
  },
});

// ------------------------------------------------------------------ the patient's file (provider) and own view (patient)
const PLAN_ROWS = "SELECT p.id, p.title, p.status, p.updated_at, (SELECT v.version FROM treatment_plan_versions v WHERE v.plan_id=p.id AND v.status='published') AS published_version, (SELECT v.review_date FROM treatment_plan_versions v WHERE v.plan_id=p.id AND v.status='published') AS review_date";

cap({
  name: 'get_patient_progress', credential: true, method: 'GET', path: '/physio/patients/:patient_id/progress', tag: TAG, auth: PROVIDER,
  summary: 'Physio/doctor: one patient\'s rehab picture: outcome series (baseline, latest, change, readings with your notes), every goal with progress, each treatment plan with the last 28 days of home-exercise adherence, and counts of signed session notes and appointments. Needs a current credential and full consent; audit-logged.',
  input: z.object({ patient_id: id }),
  async handler({ user }, i) {
    await providerGate(user, i.patient_id, 'get_patient_progress');
    const t = today();
    const [patient, outcomes, goals, plans, notes, appts, lastSeen, reports] = await Promise.all([
      one('SELECT id, display_name, handle FROM users WHERE id=$1', [i.patient_id]),
      loadOutcomes(i.patient_id, { providerId: user.id, withNotes: true }),
      many(`${GOAL_SQL} WHERE g.patient_id=$1 AND g.provider_id=$2 ORDER BY (g.status='active') DESC, g.created_at DESC`, [i.patient_id, user.id]),
      many(`${PLAN_ROWS} FROM treatment_plans p WHERE p.patient_id=$1 AND p.provider_id=$2 AND p.status<>'draft' ORDER BY p.updated_at DESC`, [i.patient_id, user.id]),
      one("SELECT count(*)::int AS n, max(signed_at) AS last_at FROM clinical_encounters WHERE athlete_id=$1 AND provider_id=$2 AND kind='encounter' AND status='signed'", [i.patient_id, user.id]),
      one("SELECT count(*) FILTER (WHERE status='completed')::int AS completed, count(*) FILTER (WHERE status='confirmed' AND starts_at >= now())::int AS upcoming, min(starts_at) FILTER (WHERE status IN ('completed','confirmed')) AS first_at FROM appointments WHERE athlete_id=$1 AND provider_id=$2", [i.patient_id, user.id]),
      one("SELECT max(starts_at) AS at FROM appointments WHERE athlete_id=$1 AND provider_id=$2 AND status='completed'", [i.patient_id, user.id]),
      one('SELECT count(*)::int AS n, max(v.published_at) AS last_at FROM physio_reports r JOIN physio_report_versions v ON v.report_id=r.id WHERE r.patient_id=$1 AND r.provider_id=$2', [i.patient_id, user.id]),
    ]);
    if (!patient) throw notFound('Patient');
    const adh = await adherenceFor(plans.map((p) => p.id), addDays(t, -27), t);
    await audit(null, user.id, 'read_clinical', 'physio_tracking', i.patient_id);
    return {
      patient, outcomes: buildSeries(outcomes), goals: goals.map((g) => shapeGoal(g, { forProvider: true })),
      plans: plans.map((p) => ({ ...p, adherence: adh.get(p.id) ?? null })),
      sessions: { signed_notes: notes.n, last_note_at: notes.last_at, appointments_completed: appts.completed, upcoming: appts.upcoming, first_appointment_at: appts.first_at, last_appointment_at: lastSeen.at },
      reports: { published: reports.n, last_published_at: reports.last_at }, measures: MEASURES,
    };
  },
});

cap({
  name: 'list_physio_goals', credential: true, method: 'GET', path: '/physio/goals', tag: TAG, auth: PROVIDER,
  summary: 'Physio/doctor: goals you set across your consented patients (or for one patient), with progress. Filter by status; goals whose date has passed come first when open.',
  input: z.object({ patient_id: id.optional(), status: z.enum(['active', 'achieved', 'not_met', 'discontinued']).optional(), ...page }),
  async handler({ user }, i) {
    await requireVerifiedProvider(user.id, { action: 'list_physio_goals', athleteId: i.patient_id ?? null, types: PROVIDER });
    const rows = await many(`${GOAL_SQL} WHERE g.provider_id=$1 AND g.patient_id IN (${ACCESS}) AND ($2::uuid IS NULL OR g.patient_id=$2) AND ($3::text IS NULL OR g.status=$3) ORDER BY (g.status='active') DESC, g.target_date NULLS LAST, g.id LIMIT $4 OFFSET $5`, [user.id, i.patient_id ?? null, i.status ?? null, i.limit, i.offset]);
    await audit(null, user.id, 'read_clinical', 'physio_goals', i.patient_id ?? null);
    return rows.map((g) => shapeGoal(g, { forProvider: true }));
  },
});

cap({
  name: 'my_physio_progress', method: 'GET', path: '/me/physio-progress', tag: TAG,
  summary: 'Patient: your own rehab progress: the goals your clinician shared with you (with progress), your measured readings over time (no clinician notes), and how much of each active exercise plan you logged in the last 28 days. Works even after you withdraw access from a clinician: it is your data.',
  input: z.object({}),
  async handler({ user }) {
    const t = today();
    const [outcomes, goals, plans] = await Promise.all([
      loadOutcomes(user.id),
      many(`${GOAL_SQL} WHERE g.patient_id=$1 AND g.shared ORDER BY (g.status='active') DESC, g.created_at DESC`, [user.id]),
      many(`${PLAN_ROWS}, (SELECT u.display_name FROM users u WHERE u.id=p.provider_id) AS provider_name FROM treatment_plans p WHERE p.patient_id=$1 AND p.status<>'draft' AND EXISTS (SELECT 1 FROM treatment_plan_versions v WHERE v.plan_id=p.id AND v.status IN ('published','superseded')) ORDER BY p.updated_at DESC`, [user.id]),
    ]);
    const adh = await adherenceFor(plans.map((p) => p.id), addDays(t, -27), t);
    return { outcomes: buildSeries(outcomes), goals: goals.map((g) => shapeGoal(g, { forProvider: false })), plans: plans.map((p) => ({ ...p, adherence: adh.get(p.id) ?? null })), measures: MEASURES };
  },
});
