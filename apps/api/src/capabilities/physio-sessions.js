import { z } from 'zod';
import { cap } from '../registry.js';
import { one, many } from '../db.js';
import { encrypt, decrypt } from '../crypto.js';
import { forbidden, notFound } from '../errors.js';

const CTX = 'physio_session_logs';
const enc = (v, k) => (v != null ? encrypt(v, `${CTX}.${k}`) : null);
const dec = (v, k) => (v ? decrypt(v, `${CTX}.${k}`) : null);

function decRow(r) {
  if (!r) return r;
  return {
    ...r,
    subjective: dec(r.subjective_enc, 'subjective'),
    objective: dec(r.objective_enc, 'objective'),
    assessment: dec(r.assessment_enc, 'assessment'),
    plan: dec(r.plan_enc, 'plan'),
    subjective_enc: undefined,
    objective_enc: undefined,
    assessment_enc: undefined,
    plan_enc: undefined,
  };
}

cap({
  name: 'create_physio_session_log', method: 'POST', path: '/physio/sessions',
  tag: 'Physio', auth: true, summary: 'Create a SOAP session note for a physio appointment',
  input: z.object({
    appointment_id: z.string().uuid().optional(),
    patient_id: z.string().uuid(),
    session_date: z.string(),
    duration_min: z.number().int().min(10).max(240).default(30),
    subjective: z.string().max(5000).optional(),
    objective: z.string().max(5000).optional(),
    assessment: z.string().max(5000).optional(),
    plan: z.string().max(5000).optional(),
    techniques_used: z.array(z.string()).default([]),
    regions_treated: z.array(z.string()).default([]),
    pain_before: z.number().int().min(0).max(10).optional(),
    pain_after: z.number().int().min(0).max(10).optional(),
    functional_score_before: z.number().optional(),
    functional_score_after: z.number().optional(),
    home_program_given: z.boolean().default(false),
    follow_up_in_days: z.number().int().min(1).max(365).optional(),
  }),
  handler: async ({ user }, i) => {
    const row = await one(
      `INSERT INTO physio_session_logs (
        appointment_id, patient_id, provider_id, session_date, duration_min,
        subjective_enc, objective_enc, assessment_enc, plan_enc,
        techniques_used, regions_treated,
        pain_before, pain_after, functional_score_before, functional_score_after,
        home_program_given, follow_up_in_days
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      RETURNING *`,
      [
        i.appointment_id ?? null, i.patient_id, user.id, i.session_date, i.duration_min,
        enc(i.subjective, 'subjective'), enc(i.objective, 'objective'),
        enc(i.assessment, 'assessment'), enc(i.plan, 'plan'),
        JSON.stringify(i.techniques_used), JSON.stringify(i.regions_treated),
        i.pain_before ?? null, i.pain_after ?? null,
        i.functional_score_before ?? null, i.functional_score_after ?? null,
        i.home_program_given, i.follow_up_in_days ?? null,
      ],
    );
    return decRow(row);
  },
});

cap({
  name: 'get_physio_session_log', method: 'GET', path: '/physio/sessions/:id',
  tag: 'Physio', auth: true, summary: 'Get a single SOAP session note',
  input: z.object({ id: z.string().uuid() }),
  handler: async ({ user }, i) => {
    const row = await one(`SELECT * FROM physio_session_logs WHERE id=$1`, [i.id]);
    if (!row) throw notFound();
    if (row.provider_id !== user.id && row.patient_id !== user.id) throw forbidden();
    return decRow(row);
  },
});

cap({
  name: 'list_physio_session_logs', method: 'GET', path: '/physio/patients/:patient_id/sessions',
  tag: 'Physio', auth: true, summary: 'List SOAP session notes for a patient',
  input: z.object({ patient_id: z.string().uuid() }),
  handler: async ({ user }, i) => {
    const rows = await many(
      `SELECT * FROM physio_session_logs
       WHERE patient_id=$1 AND (provider_id=$2 OR patient_id=$2)
       ORDER BY session_date DESC, created_at DESC`,
      [i.patient_id, user.id],
    );
    return rows.map(decRow);
  },
});

cap({
  name: 'update_physio_session_log', method: 'PATCH', path: '/physio/sessions/:id',
  tag: 'Physio', auth: true, summary: 'Update a SOAP session note (provider only)',
  input: z.object({
    id: z.string().uuid(),
    subjective: z.string().max(5000).optional(),
    objective: z.string().max(5000).optional(),
    assessment: z.string().max(5000).optional(),
    plan: z.string().max(5000).optional(),
    pain_before: z.number().int().min(0).max(10).optional(),
    pain_after: z.number().int().min(0).max(10).optional(),
    home_program_given: z.boolean().optional(),
    follow_up_in_days: z.number().int().optional(),
    techniques_used: z.array(z.string()).optional(),
    regions_treated: z.array(z.string()).optional(),
  }),
  handler: async ({ user }, i) => {
    const existing = await one(`SELECT provider_id FROM physio_session_logs WHERE id=$1`, [i.id]);
    if (!existing) throw notFound();
    if (existing.provider_id !== user.id) throw forbidden();
    const row = await one(
      `UPDATE physio_session_logs SET
        subjective_enc = CASE WHEN $2::text IS NOT NULL THEN $2 ELSE subjective_enc END,
        objective_enc  = CASE WHEN $3::text IS NOT NULL THEN $3 ELSE objective_enc END,
        assessment_enc = CASE WHEN $4::text IS NOT NULL THEN $4 ELSE assessment_enc END,
        plan_enc       = CASE WHEN $5::text IS NOT NULL THEN $5 ELSE plan_enc END,
        pain_before    = COALESCE($6, pain_before),
        pain_after     = COALESCE($7, pain_after),
        home_program_given = COALESCE($8, home_program_given),
        follow_up_in_days  = COALESCE($9, follow_up_in_days),
        techniques_used = COALESCE($10::jsonb, techniques_used),
        regions_treated = COALESCE($11::jsonb, regions_treated),
        updated_at = now()
       WHERE id=$1 RETURNING *`,
      [
        i.id,
        i.subjective !== undefined ? enc(i.subjective, 'subjective') : null,
        i.objective !== undefined ? enc(i.objective, 'objective') : null,
        i.assessment !== undefined ? enc(i.assessment, 'assessment') : null,
        i.plan !== undefined ? enc(i.plan, 'plan') : null,
        i.pain_before ?? null, i.pain_after ?? null,
        i.home_program_given ?? null, i.follow_up_in_days ?? null,
        i.techniques_used ? JSON.stringify(i.techniques_used) : null,
        i.regions_treated ? JSON.stringify(i.regions_treated) : null,
      ],
    );
    return decRow(row);
  },
});
