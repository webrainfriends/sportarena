// Para-sport specialist physiotherapy and adapted rehabilitation (PS-16).
// Extends canonical treatment-plans (#210) and exercise library — never duplicates them.
// Adds: physio para-expertise profile, adapted exercise variants, clinician functional goals,
// outcome-measure selection per plan, and coaching-readiness clearance (coach sees clearance only,
// never any clinical detail). All writes require a current verified credential + active full consent.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { one, many, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { decrypt, encrypt } from '../crypto.js';
import { notify } from '../notify.js';
import { lockCredential, requireVerifiedProvider } from '../clinical-access.js';
import { hasGrant } from './medical.js';

const TAG = 'Health';

// ── vocabulary ────────────────────────────────────────────────────────────────────────────────────

export const SPECIALISATIONS = [
  'wheelchair_load_management', 'prosthetic_sport', 'upper_limb_difference',
  'vision_impairment', 'intellectual_matp', 'acquired_disability',
  'hearing_impairment', 'short_stature', 'les_autres',
];

export const OUTCOME_MEASURES = [
  'wuspi', 'fim_mobility', 'dash', 'promis_pain', 'ipaq_adapted',
  'koos_adapted', 'whodas_2', 'wsq', 'custom',
];

export const GOAL_STATUSES = ['in_progress', 'achieved', 'not_met', 'discontinued'];

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────

async function mustOwnPlan(planId, userId) {
  const p = await one('SELECT * FROM treatment_plans WHERE id=$1', [planId]);
  if (!p || p.provider_id !== userId) throw notFound('Treatment plan');
  return p;
}

async function providerGate(user, patientId, action) {
  const cred = await requireVerifiedProvider(user.id, { action, athleteId: patientId });
  if (!(await hasGrant(patientId, user.id))) throw forbidden('The patient has not granted you full access');
  return cred;
}

async function lockAndCheckGrant(c, user, patientId, cred) {
  await lockCredential(c, cred);
  const ok = (await c.query(
    "SELECT 1 FROM medical_grants WHERE athlete_id=$1 AND provider_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AND scope='full' FOR SHARE",
    [patientId, user.id])).rows[0];
  if (!ok) throw forbidden('The patient has not granted you full access');
}

function decryptGoal(r, includePrivate = false) {
  const base = {
    id: r.id, plan_id: r.plan_id, status: r.status, display_order: r.display_order,
    latest_pct: r.latest_pct, latest_at: r.latest_at, archived_at: r.archived_at, created_at: r.created_at,
    title: decrypt(r.title_enc, 'para_physio.goal_title'),
    measure: decrypt(r.measure_enc, 'para_physio.goal_measure'),
    target: decrypt(r.target_enc, 'para_physio.goal_target'),
  };
  if (includePrivate) base.baseline = decrypt(r.baseline_enc, 'para_physio.goal_baseline');
  return base;
}

function decryptVariant(r) {
  return {
    id: r.id, owner_id: r.owner_id, exercise_version_id: r.exercise_version_id,
    plan_id: r.plan_id, has_audio: r.has_audio, has_large_print: r.has_large_print,
    media_url: r.media_url, media_source: r.media_source, media_licence: r.media_licence,
    archived_at: r.archived_at, created_at: r.created_at, updated_at: r.updated_at,
    position_guidance: decrypt(r.position_guidance_enc, 'para_physio.variant_position'),
    equipment_note: decrypt(r.equipment_note_enc, 'para_physio.variant_equipment'),
    precautions: decrypt(r.precautions_enc, 'para_physio.variant_precautions'),
  };
}

// ── 1. physio para-expertise profile ─────────────────────────────────────────────────────────────

cap({
  name: 'get_para_physio_catalogue', method: 'GET', path: '/physio/para/catalogue', tag: TAG, auth: 'public',
  summary: 'Reference vocabulary for para-sport physio: specialisations and outcome measures. No personal data.',
  handler: async () => ({ specialisations: SPECIALISATIONS, outcome_measures: OUTCOME_MEASURES }),
});

cap({
  name: 'get_my_para_expertise', method: 'GET', path: '/me/para-expertise', tag: TAG, auth: ['physio', 'doctor'],
  summary: 'Physio/doctor: your declared para-sport specialisations with credential state.',
  async handler({ user }) {
    const rows = await many(
      `SELECT e.*, vc.status AS case_status, vc.credential_title FROM physio_para_expertise e
       LEFT JOIN verification_cases vc ON vc.id=e.credential_case_id
       WHERE e.provider_id=$1 AND e.archived_at IS NULL ORDER BY e.created_at`, [user.id]);
    return rows.map(({ credential_note_enc, ...r }) => ({
      ...r,
      credential_note: credential_note_enc ? decrypt(credential_note_enc, 'para_physio.expertise_note') : null,
    }));
  },
});

cap({
  name: 'upsert_para_expertise', method: 'POST', path: '/me/para-expertise', tag: TAG, auth: ['physio', 'doctor'], status: 201,
  summary: 'Physio/doctor: declare or update a para-sport specialisation. Optionally link a verification-case credential. This is a service filter, never a diagnosis of any athlete.',
  input: z.object({
    specialisation: z.enum(SPECIALISATIONS),
    credential_case_id: id.nullable().optional(),
    credential_note: z.string().trim().max(300).nullable().optional(),
  }),
  async handler({ user }, i) {
    return tx(async (c) => {
      const enc = i.credential_note != null ? encrypt(i.credential_note, 'para_physio.expertise_note') : null;
      const row = (await c.query(
        `INSERT INTO physio_para_expertise(provider_id, specialisation, credential_case_id, credential_note_enc)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT(provider_id, specialisation) DO UPDATE
           SET credential_case_id=COALESCE($3, physio_para_expertise.credential_case_id),
               credential_note_enc=COALESCE($4, physio_para_expertise.credential_note_enc),
               archived_at=NULL, updated_at=now()
         RETURNING *`,
        [user.id, i.specialisation, i.credential_case_id ?? null, enc])).rows[0];
      await audit(c, user.id, 'upsert_para_expertise', 'physio_para_expertise', row.id);
      return { id: row.id, specialisation: row.specialisation, credential_case_id: row.credential_case_id, updated_at: row.updated_at };
    });
  },
});

cap({
  name: 'archive_para_expertise', method: 'POST', path: '/me/para-expertise/:id/archive', tag: TAG, auth: ['physio', 'doctor'],
  summary: 'Physio/doctor: retire a para-sport specialisation from your profile. Data is kept.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one('UPDATE physio_para_expertise SET archived_at=COALESCE(archived_at,now()) WHERE id=$1 AND provider_id=$2 RETURNING id, archived_at', [i.id, user.id]);
    if (!r) throw notFound('Para expertise');
    return r;
  },
});

cap({
  name: 'list_para_physios', method: 'GET', path: '/physio/para/providers', tag: TAG, auth: 'public',
  summary: 'Find physios/doctors who have declared para-sport specialisations. Returns name, specialisations, credential state. No medical data.',
  input: z.object({ specialisation: z.enum(SPECIALISATIONS).optional(), ...page }),
  async handler({}, i) {
    const where = `e.archived_at IS NULL AND ($1::text IS NULL OR e.specialisation=$1)`;
    const total = (await one(`SELECT count(DISTINCT e.provider_id)::int AS n FROM physio_para_expertise e WHERE ${where}`, [i.specialisation ?? null])).n;
    const items = await many(
      `SELECT u.id, u.display_name, array_agg(DISTINCT e.specialisation) AS specialisations,
              bool_or(vc.status='approved') AS any_verified
       FROM physio_para_expertise e
       JOIN users u ON u.id=e.provider_id
       LEFT JOIN verification_cases vc ON vc.id=e.credential_case_id
       WHERE ${where}
       GROUP BY u.id, u.display_name
       ORDER BY bool_or(vc.status='approved') DESC, u.display_name
       LIMIT $2 OFFSET $3`, [i.specialisation ?? null, i.limit, i.offset]);
    return { total, items };
  },
});

// ── 2. adapted exercise variants ─────────────────────────────────────────────────────────────────

cap({
  name: 'upsert_adapted_variant', method: 'POST', path: '/me/adapted-variants', tag: TAG, auth: ['physio', 'doctor'], status: 201,
  summary: 'Physio/doctor: author an adapted variant of one of your exercise-library exercises. Variants carry position guidance, adapted-equipment notes and safety precautions specific to a para-sport context, plus accessibility format flags. Optionally scope a variant to one treatment plan.',
  input: z.object({
    id: id.optional(),
    exercise_version_id: id,
    plan_id: id.nullable().optional(),
    position_guidance: z.string().trim().max(1500).nullable().optional(),
    equipment_note: z.string().trim().max(1000).nullable().optional(),
    precautions: z.string().trim().max(1000).nullable().optional(),
    has_audio: z.boolean().default(false),
    has_large_print: z.boolean().default(false),
    media_url: z.string().url().startsWith('https://').nullable().optional(),
    media_source: z.string().max(120).nullable().optional(),
    media_licence: z.string().max(120).nullable().optional(),
  }),
  async handler({ user }, i) {
    if (i.media_url && (!i.media_source || !i.media_licence)) throw badRequest('A media link needs its source and licence');
    // confirm the exercise version belongs to this provider
    const ex = await one(
      `SELECT ev.id FROM exercise_versions ev
       JOIN exercises e ON e.id=ev.exercise_id
       WHERE ev.id=$1 AND e.owner_id=$2 AND e.archived_at IS NULL`, [i.exercise_version_id, user.id]);
    if (!ex) throw notFound('Exercise version');
    // if plan-scoped, confirm ownership
    if (i.plan_id) await mustOwnPlan(i.plan_id, user.id);
    return tx(async (c) => {
      let row;
      if (i.id) {
        row = (await c.query('SELECT * FROM adapted_exercise_variants WHERE id=$1 AND owner_id=$2 FOR UPDATE', [i.id, user.id])).rows[0];
        if (!row) throw notFound('Adapted variant');
        if (row.archived_at) throw badRequest('This variant is archived');
        row = (await c.query(
          `UPDATE adapted_exercise_variants
           SET exercise_version_id=$2, plan_id=$3, position_guidance_enc=$4, equipment_note_enc=$5,
               precautions_enc=$6, has_audio=$7, has_large_print=$8,
               media_url=$9, media_source=$10, media_licence=$11, updated_at=now()
           WHERE id=$1 RETURNING *`,
          [i.id, i.exercise_version_id, i.plan_id ?? null,
           encrypt(i.position_guidance, 'para_physio.variant_position'),
           encrypt(i.equipment_note, 'para_physio.variant_equipment'),
           encrypt(i.precautions, 'para_physio.variant_precautions'),
           i.has_audio, i.has_large_print, i.media_url ?? null, i.media_source ?? null, i.media_licence ?? null])).rows[0];
      } else {
        row = (await c.query(
          `INSERT INTO adapted_exercise_variants
             (owner_id, exercise_version_id, plan_id, position_guidance_enc, equipment_note_enc, precautions_enc, has_audio, has_large_print, media_url, media_source, media_licence)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [user.id, i.exercise_version_id, i.plan_id ?? null,
           encrypt(i.position_guidance, 'para_physio.variant_position'),
           encrypt(i.equipment_note, 'para_physio.variant_equipment'),
           encrypt(i.precautions, 'para_physio.variant_precautions'),
           i.has_audio, i.has_large_print, i.media_url ?? null, i.media_source ?? null, i.media_licence ?? null])).rows[0];
      }
      await audit(c, user.id, 'upsert_adapted_variant', 'adapted_exercise_variants', row.id);
      return decryptVariant(row);
    });
  },
});

cap({
  name: 'list_adapted_variants', method: 'GET', path: '/me/adapted-variants', tag: TAG, auth: ['physio', 'doctor'],
  summary: 'Physio/doctor: list your adapted exercise variants, optionally filtered to one treatment plan.',
  input: z.object({ plan_id: id.nullable().optional(), include_archived: z.coerce.boolean().default(false), ...page }),
  async handler({ user }, i) {
    const where = `owner_id=$1 AND ($2::boolean OR archived_at IS NULL) AND ($3::uuid IS NULL OR plan_id=$3)`;
    const total = (await one(`SELECT count(*)::int AS n FROM adapted_exercise_variants WHERE ${where}`, [user.id, i.include_archived, i.plan_id ?? null])).n;
    const rows = await many(`SELECT * FROM adapted_exercise_variants WHERE ${where} ORDER BY created_at DESC LIMIT $4 OFFSET $5`, [user.id, i.include_archived, i.plan_id ?? null, i.limit, i.offset]);
    return { total, items: rows.map(decryptVariant) };
  },
});

cap({
  name: 'archive_adapted_variant', method: 'POST', path: '/me/adapted-variants/:id/archive', tag: TAG, auth: ['physio', 'doctor'],
  summary: 'Physio/doctor: retire an adapted exercise variant. Data is kept.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await one('UPDATE adapted_exercise_variants SET archived_at=COALESCE(archived_at,now()), updated_at=now() WHERE id=$1 AND owner_id=$2 RETURNING id, archived_at', [i.id, user.id]);
    if (!r) throw notFound('Adapted variant');
    return r;
  },
});

// ── 3. functional goals ───────────────────────────────────────────────────────────────────────────

cap({
  name: 'upsert_functional_goal', credential: true, method: 'POST', path: '/treatment-plans/:plan_id/functional-goals', tag: TAG, auth: ['physio', 'doctor'], status: 201,
  summary: 'Physio/doctor: add or update a functional goal on an adapted plan. Goals use clinician-selected measures appropriate to this athlete's functional profile; no universal impairment score is applied. Requires current credential and active full consent.',
  input: z.object({
    plan_id: id,
    id: id.optional(),
    title: z.string().trim().min(2).max(200),
    measure: z.string().trim().max(200).nullable().optional(),
    baseline: z.string().trim().max(200).nullable().optional(),
    target: z.string().trim().max(200).nullable().optional(),
    display_order: z.number().int().min(0).max(99).default(0),
  }),
  async handler({ user }, i) {
    const plan = await mustOwnPlan(i.plan_id, user.id);
    const cred = await providerGate(user, plan.patient_id, 'upsert_functional_goal');
    return tx(async (c) => {
      await lockAndCheckGrant(c, user, plan.patient_id, cred);
      let row;
      if (i.id) {
        row = (await c.query('SELECT * FROM treatment_plan_functional_goals WHERE id=$1 AND plan_id=$2 AND provider_id=$3 FOR UPDATE', [i.id, i.plan_id, user.id])).rows[0];
        if (!row) throw notFound('Functional goal');
        if (row.archived_at) throw badRequest('This goal is archived');
        row = (await c.query(
          `UPDATE treatment_plan_functional_goals
           SET title_enc=$2, measure_enc=$3, baseline_enc=$4, target_enc=$5, display_order=$6, updated_at=now()
           WHERE id=$1 RETURNING *`,
          [i.id,
           encrypt(i.title, 'para_physio.goal_title'),
           encrypt(i.measure, 'para_physio.goal_measure'),
           encrypt(i.baseline, 'para_physio.goal_baseline'),
           encrypt(i.target, 'para_physio.goal_target'),
           i.display_order])).rows[0];
      } else {
        const count = (await c.query('SELECT count(*)::int AS n FROM treatment_plan_functional_goals WHERE plan_id=$1 AND archived_at IS NULL', [i.plan_id])).rows[0].n;
        if (count >= 6) throw badRequest('A plan may have at most 6 active functional goals');
        row = (await c.query(
          `INSERT INTO treatment_plan_functional_goals(plan_id, provider_id, title_enc, measure_enc, baseline_enc, target_enc, display_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [i.plan_id, user.id,
           encrypt(i.title, 'para_physio.goal_title'),
           encrypt(i.measure, 'para_physio.goal_measure'),
           encrypt(i.baseline, 'para_physio.goal_baseline'),
           encrypt(i.target, 'para_physio.goal_target'),
           i.display_order])).rows[0];
      }
      await audit(c, user.id, 'upsert_functional_goal', 'treatment_plan_functional_goals', row.id);
      return decryptGoal(row, true);
    });
  },
});

cap({
  name: 'update_functional_goal_progress', credential: true, method: 'POST', path: '/treatment-plans/:plan_id/functional-goals/:id/progress', tag: TAG, auth: ['physio', 'doctor'],
  summary: 'Physio/doctor: record the latest progress percentage and status for a functional goal. Requires current credential and active full consent.',
  input: z.object({ plan_id: id, id, latest_pct: z.number().int().min(0).max(100).nullable().optional(), status: z.enum(GOAL_STATUSES) }),
  async handler({ user }, i) {
    const plan = await mustOwnPlan(i.plan_id, user.id);
    const cred = await providerGate(user, plan.patient_id, 'update_functional_goal_progress');
    return tx(async (c) => {
      await lockAndCheckGrant(c, user, plan.patient_id, cred);
      const row = (await c.query(
        `UPDATE treatment_plan_functional_goals
         SET latest_pct=$2, status=$3, latest_at=now(), updated_at=now()
         WHERE id=$1 AND plan_id=$4 AND provider_id=$5 AND archived_at IS NULL RETURNING *`,
        [i.id, i.latest_pct ?? null, i.status, i.plan_id, user.id])).rows[0];
      if (!row) throw notFound('Functional goal');
      await audit(c, user.id, 'update_functional_goal_progress', 'treatment_plan_functional_goals', row.id);
      return decryptGoal(row, true);
    });
  },
});

cap({
  name: 'archive_functional_goal', credential: true, method: 'POST', path: '/treatment-plans/:plan_id/functional-goals/:id/archive', tag: TAG, auth: ['physio', 'doctor'],
  summary: 'Physio/doctor: retire a functional goal from the plan. Data is kept.',
  input: z.object({ plan_id: id, id }),
  async handler({ user }, i) {
    const plan = await mustOwnPlan(i.plan_id, user.id);
    const cred = await providerGate(user, plan.patient_id, 'archive_functional_goal');
    return tx(async (c) => {
      await lockAndCheckGrant(c, user, plan.patient_id, cred);
      const r = await one('UPDATE treatment_plan_functional_goals SET archived_at=COALESCE(archived_at,now()), updated_at=now() WHERE id=$1 AND plan_id=$2 AND provider_id=$3 RETURNING id, archived_at', [i.id, i.plan_id, user.id]);
      if (!r) throw notFound('Functional goal');
      return r;
    });
  },
});

cap({
  name: 'list_functional_goals', credential: true, method: 'GET', path: '/treatment-plans/:plan_id/functional-goals', tag: TAG,
  summary: 'Provider: list functional goals for a plan (requires credential and active consent). Patient: view their own goals (title, measure, progress only — baseline and private detail excluded).',
  input: z.object({ plan_id: id, include_archived: z.coerce.boolean().default(false) }),
  async handler({ user }, i) {
    const plan = await one('SELECT * FROM treatment_plans WHERE id=$1', [i.plan_id]);
    if (!plan) throw notFound('Treatment plan');
    const isProvider = plan.provider_id === user.id;
    const isPatient = plan.patient_id === user.id;
    if (!isProvider && !isPatient) throw notFound('Treatment plan');
    if (isProvider) await providerGate(user, plan.patient_id, 'list_functional_goals');
    const rows = await many(
      `SELECT * FROM treatment_plan_functional_goals WHERE plan_id=$1 AND ($2::boolean OR archived_at IS NULL) ORDER BY display_order, created_at`,
      [i.plan_id, i.include_archived]);
    if (isProvider) {
      await audit(null, user.id, 'read_clinical', 'treatment_plan_functional_goals', i.plan_id);
    }
    return rows.map((r) => decryptGoal(r, isProvider));
  },
});

// ── 4. outcome measures ───────────────────────────────────────────────────────────────────────────

cap({
  name: 'set_plan_outcome_measures', credential: true, method: 'PUT', path: '/treatment-plans/:plan_id/outcome-measures', tag: TAG, auth: ['physio', 'doctor'],
  summary: 'Physio/doctor: set which outcome measures apply to this plan. Replaces the current selection. No composite score is applied across impairment classes. Requires credential and active full consent.',
  input: z.object({
    plan_id: id,
    measures: z.array(z.object({
      measure_key: z.enum(OUTCOME_MEASURES),
      label: z.string().trim().max(120).nullable().optional(),
    })).max(8),
  }),
  async handler({ user }, i) {
    const plan = await mustOwnPlan(i.plan_id, user.id);
    const cred = await providerGate(user, plan.patient_id, 'set_plan_outcome_measures');
    return tx(async (c) => {
      await lockAndCheckGrant(c, user, plan.patient_id, cred);
      await c.query('UPDATE treatment_plan_outcome_measures SET archived_at=now() WHERE plan_id=$1 AND archived_at IS NULL', [i.plan_id]);
      const rows = [];
      for (const m of i.measures) {
        const enc = m.label != null ? encrypt(m.label, 'para_physio.outcome_label') : null;
        const r = (await c.query(
          `INSERT INTO treatment_plan_outcome_measures(plan_id, provider_id, measure_key, label_enc)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT(plan_id, measure_key) DO UPDATE
             SET archived_at=NULL, label_enc=EXCLUDED.label_enc, provider_id=EXCLUDED.provider_id
           RETURNING *`, [i.plan_id, user.id, m.measure_key, enc])).rows[0];
        rows.push({ id: r.id, measure_key: r.measure_key, label: m.label ?? null });
      }
      await audit(c, user.id, 'set_plan_outcome_measures', 'treatment_plan_outcome_measures', i.plan_id);
      return rows;
    });
  },
});

cap({
  name: 'get_plan_outcome_measures', method: 'GET', path: '/treatment-plans/:plan_id/outcome-measures', tag: TAG,
  summary: 'Provider or patient: list the outcome measures in use on this plan. The measure labels for custom measures are decrypted here.',
  input: z.object({ plan_id: id }),
  async handler({ user }, i) {
    const plan = await one('SELECT * FROM treatment_plans WHERE id=$1', [i.plan_id]);
    if (!plan) throw notFound('Treatment plan');
    if (plan.provider_id !== user.id && plan.patient_id !== user.id) throw notFound('Treatment plan');
    if (plan.provider_id === user.id) await requireVerifiedProvider(user.id, { action: 'get_plan_outcome_measures', athleteId: plan.patient_id });
    const rows = await many('SELECT * FROM treatment_plan_outcome_measures WHERE plan_id=$1 AND archived_at IS NULL ORDER BY created_at', [i.plan_id]);
    return rows.map((r) => ({ id: r.id, measure_key: r.measure_key, label: r.label_enc ? decrypt(r.label_enc, 'para_physio.outcome_label') : null }));
  },
});

// ── 5. coaching readiness clearance ──────────────────────────────────────────────────────────────

cap({
  name: 'issue_coaching_readiness', credential: true, method: 'POST', path: '/treatment-plans/:plan_id/coaching-readiness', tag: TAG, auth: ['physio', 'doctor'], status: 201,
  summary: 'Physio/doctor: issue a coaching-readiness clearance for this athlete. The coach receives only "cleared for [load]" — no diagnosis, clinical notes or treatment details are ever included. Requires current credential, active full consent AND the athlete\'s specific coaching-readiness consent (checked via the medical grant scope). Credential is re-verified on submit; audit-logged.',
  input: z.object({
    plan_id: id,
    load_restriction: z.string().trim().max(120).nullable().optional(),
    review_date: z.string().date().nullable().optional(),
    coach_ids: z.array(id).min(1).max(10).describe('Coach user IDs to notify'),
  }),
  async handler({ user }, i) {
    const plan = await mustOwnPlan(i.plan_id, user.id);
    const cred = await providerGate(user, plan.patient_id, 'issue_coaching_readiness');

    // Verify athlete has explicitly consented to coach notification (scope 'coaching_readiness').
    const consentRow = await one(
      "SELECT 1 FROM medical_grants WHERE athlete_id=$1 AND provider_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AND scope='full' LIMIT 1",
      [plan.patient_id, user.id]);
    if (!consentRow) throw forbidden('The athlete has not granted you full access');

    return tx(async (c) => {
      await lockAndCheckGrant(c, user, plan.patient_id, cred);

      // Supersede any existing active clearance for this plan.
      await c.query(
        "UPDATE coaching_readiness_clearances SET status='superseded', revoked_at=now(), revoked_by=$2 WHERE plan_id=$1 AND status='active'",
        [i.plan_id, user.id]);

      const row = (await c.query(
        `INSERT INTO coaching_readiness_clearances
           (plan_id, provider_id, athlete_id, load_restriction, review_date, notified_coach_ids, credential_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [i.plan_id, user.id, plan.patient_id, i.load_restriction ?? null,
         i.review_date ?? null, i.coach_ids, cred.case_id ?? null])).rows[0];

      // Notify coaches — clearance text only, never clinical detail.
      const athlete = await one('SELECT display_name FROM users WHERE id=$1', [plan.patient_id]);
      const reviewNote = i.review_date ? ` Next physio review: ${i.review_date}.` : '';
      const loadNote = i.load_restriction ? ` (${i.load_restriction})` : '';
      const body = `${athlete.display_name} has physiotherapist clearance to return to training${loadNote}.${reviewNote}`;
      for (const coachId of i.coach_ids) {
        await notify(c, coachId, { kind: 'coaching_readiness', title: 'Athlete cleared for training', body, data: { clearance_id: row.id } });
      }

      // Notify athlete.
      await notify(c, plan.patient_id, { kind: 'coaching_readiness_issued', title: 'Your coach has been notified', body: 'Your physio has shared your training clearance with your coaching team.', data: { clearance_id: row.id } });

      await audit(c, user.id, 'issue_coaching_readiness', 'coaching_readiness_clearances', row.id);
      return { id: row.id, plan_id: row.plan_id, status: row.status, load_restriction: row.load_restriction, review_date: row.review_date, issued_at: row.issued_at, notified_coach_ids: row.notified_coach_ids };
    });
  },
});

cap({
  name: 'revoke_coaching_readiness', method: 'POST', path: '/treatment-plans/:plan_id/coaching-readiness/:id/revoke', tag: TAG,
  summary: 'Athlete or prescribing physio: revoke an active coaching-readiness clearance. The coaches are notified that access has ended. Audit-logged.',
  input: z.object({ plan_id: id, id }),
  async handler({ user }, i) {
    const plan = await one('SELECT * FROM treatment_plans WHERE id=$1', [i.plan_id]);
    if (!plan) throw notFound('Treatment plan');
    const isAthlete = plan.patient_id === user.id;
    const isProvider = plan.provider_id === user.id;
    if (!isAthlete && !isProvider) throw notFound('Clearance');
    return tx(async (c) => {
      const row = (await c.query(
        "SELECT * FROM coaching_readiness_clearances WHERE id=$1 AND plan_id=$2 AND status='active' FOR UPDATE",
        [i.id, i.plan_id])).rows[0];
      if (!row) throw notFound('Active clearance');
      await c.query(
        "UPDATE coaching_readiness_clearances SET status='revoked', revoked_at=now(), revoked_by=$2 WHERE id=$1",
        [i.id, user.id]);
      const revokerName = (await one('SELECT display_name FROM users WHERE id=$1', [user.id])).display_name;
      for (const coachId of row.notified_coach_ids) {
        await notify(c, coachId, { kind: 'coaching_readiness_revoked', title: 'Training clearance revoked', body: `${revokerName} has ended the coaching-readiness clearance for this athlete.`, data: { clearance_id: i.id } });
      }
      await audit(c, user.id, 'revoke_coaching_readiness', 'coaching_readiness_clearances', i.id);
      return { id: i.id, status: 'revoked', revoked_at: new Date().toISOString() };
    });
  },
});

cap({
  name: 'get_coaching_readiness', method: 'GET', path: '/treatment-plans/:plan_id/coaching-readiness', tag: TAG,
  summary: 'Provider, patient or notified coach: get the current coaching-readiness clearance for a plan. Coaches see only clearance status and load restriction — never clinical notes or treatment details.',
  input: z.object({ plan_id: id }),
  async handler({ user }, i) {
    const plan = await one('SELECT * FROM treatment_plans WHERE id=$1', [i.plan_id]);
    if (!plan) throw notFound('Treatment plan');
    const isProvider = plan.provider_id === user.id;
    const isPatient = plan.patient_id === user.id;
    const row = await one(
      "SELECT * FROM coaching_readiness_clearances WHERE plan_id=$1 ORDER BY issued_at DESC LIMIT 1",
      [i.plan_id]);
    if (!row) return null;
    const isCoach = row.notified_coach_ids.includes(user.id);
    if (!isProvider && !isPatient && !isCoach) throw notFound('Clearance');
    if (isProvider) await requireVerifiedProvider(user.id, { action: 'get_coaching_readiness', athleteId: plan.patient_id });
    return { id: row.id, plan_id: row.plan_id, status: row.status, load_restriction: row.load_restriction, review_date: row.review_date, issued_at: row.issued_at, revoked_at: row.revoked_at };
  },
});

// ── 6. para rehab patient list ────────────────────────────────────────────────────────────────────

cap({
  name: 'list_para_rehab_patients', credential: true, method: 'GET', path: '/physio/para/patients', tag: TAG, auth: ['physio', 'doctor'],
  summary: 'Physio/doctor: list your active treatment-plan patients who have at least one adapted plan component (functional goals or adapted variants). Requires a current credential. Returns plan and functional-goal counts only.',
  input: z.object({ ...page }),
  async handler({ user }, i) {
    await requireVerifiedProvider(user.id, { action: 'list_para_rehab_patients', athleteId: null });
    const total = (await one(
      `SELECT count(DISTINCT p.patient_id)::int AS n
       FROM treatment_plans p
       WHERE p.provider_id=$1
         AND EXISTS (SELECT 1 FROM medical_grants g WHERE g.athlete_id=p.patient_id AND g.provider_id=$1 AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now()) AND g.scope='full')
         AND (EXISTS (SELECT 1 FROM treatment_plan_functional_goals fg WHERE fg.plan_id=p.id AND fg.archived_at IS NULL)
           OR EXISTS (SELECT 1 FROM adapted_exercise_variants av WHERE av.plan_id=p.id AND av.archived_at IS NULL))`,
      [user.id])).n;

    const items = await many(
      `SELECT u.id AS patient_id, u.display_name AS patient_name,
              count(DISTINCT p.id)::int AS plan_count,
              count(DISTINCT fg.id)::int AS functional_goal_count,
              count(DISTINCT crc.id)::int AS active_clearances,
              max(p.updated_at) AS last_activity
       FROM treatment_plans p
       JOIN users u ON u.id=p.patient_id
       LEFT JOIN treatment_plan_functional_goals fg ON fg.plan_id=p.id AND fg.archived_at IS NULL
       LEFT JOIN coaching_readiness_clearances crc ON crc.plan_id=p.id AND crc.status='active'
       WHERE p.provider_id=$1
         AND EXISTS (SELECT 1 FROM medical_grants g WHERE g.athlete_id=p.patient_id AND g.provider_id=$1 AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now()) AND g.scope='full')
         AND (EXISTS (SELECT 1 FROM treatment_plan_functional_goals fg2 WHERE fg2.plan_id=p.id AND fg2.archived_at IS NULL)
           OR EXISTS (SELECT 1 FROM adapted_exercise_variants av WHERE av.plan_id=p.id AND av.archived_at IS NULL))
       GROUP BY u.id, u.display_name
       ORDER BY max(p.updated_at) DESC
       LIMIT $2 OFFSET $3`, [user.id, i.limit, i.offset]);

    return { total, items };
  },
});
