import { z } from 'zod';
import { cap } from '../registry.js';
import { one, many } from '../db.js';
import { encrypt, decrypt } from '../crypto.js';
import { forbidden, notFound } from '../errors.js';

const CTX = 'physio_milestones';
const enc = (v, k) => (v != null ? encrypt(v, `${CTX}.${k}`) : null);
const dec = (v, k) => (v ? decrypt(v, `${CTX}.${k}`) : null);
const decRow = (r) => r ? { ...r, description: dec(r.description_enc, 'description'), evidence: dec(r.evidence_enc, 'evidence'), description_enc: undefined, evidence_enc: undefined } : r;

cap({
  name: 'create_physio_milestone', method: 'POST', path: '/physio/milestones',
  tag: 'Physio', auth: true, summary: 'Create a recovery milestone on a treatment plan',
  input: z.object({
    treatment_plan_id: z.string().uuid().optional(),
    patient_id: z.string().uuid(),
    title: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    target_date: z.string().optional(),
    milestone_type: z.enum(['functional', 'pain', 'return_to_sport', 'rtp_stage', 'custom']).default('functional'),
    sort_order: z.number().int().default(0),
  }),
  handler: async ({ user }, i) => {
    const row = await one(
      `INSERT INTO physio_milestones (treatment_plan_id, patient_id, provider_id, title, description_enc, target_date, milestone_type, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [i.treatment_plan_id ?? null, i.patient_id, user.id, i.title, enc(i.description, 'description'), i.target_date ?? null, i.milestone_type, i.sort_order],
    );
    return decRow(row);
  },
});

cap({
  name: 'update_physio_milestone', method: 'PATCH', path: '/physio/milestones/:id',
  tag: 'Physio', auth: true, summary: 'Update a recovery milestone',
  input: z.object({
    id: z.string().uuid(),
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    target_date: z.string().optional(),
    sort_order: z.number().int().optional(),
  }),
  handler: async ({ user }, i) => {
    const existing = await one(`SELECT provider_id FROM physio_milestones WHERE id=$1 AND archived_at IS NULL`, [i.id]);
    if (!existing) throw notFound();
    if (existing.provider_id !== user.id) throw forbidden();
    const row = await one(
      `UPDATE physio_milestones SET
        title       = COALESCE($2, title),
        description_enc = CASE WHEN $3::text IS NOT NULL THEN $3 ELSE description_enc END,
        target_date = COALESCE($4::date, target_date),
        sort_order  = COALESCE($5, sort_order),
        updated_at  = now()
       WHERE id=$1 RETURNING *`,
      [i.id, i.title ?? null, i.description !== undefined ? enc(i.description, 'description') : null, i.target_date ?? null, i.sort_order ?? null],
    );
    return decRow(row);
  },
});

cap({
  name: 'achieve_physio_milestone', method: 'POST', path: '/physio/milestones/:id/achieve',
  tag: 'Physio', auth: true, summary: 'Mark a recovery milestone as achieved',
  input: z.object({ id: z.string().uuid(), evidence: z.string().max(2000).optional() }),
  handler: async ({ user }, i) => {
    const existing = await one(`SELECT provider_id, patient_id FROM physio_milestones WHERE id=$1 AND archived_at IS NULL`, [i.id]);
    if (!existing) throw notFound();
    if (existing.provider_id !== user.id && existing.patient_id !== user.id) throw forbidden();
    const row = await one(
      `UPDATE physio_milestones SET achieved_at=now(), evidence_enc=$2, updated_at=now() WHERE id=$1 RETURNING *`,
      [i.id, enc(i.evidence, 'evidence')],
    );
    return decRow(row);
  },
});

cap({
  name: 'list_physio_milestones', method: 'GET', path: '/physio/patients/:patient_id/milestones',
  tag: 'Physio', auth: true, summary: 'List recovery milestones for a patient',
  input: z.object({ patient_id: z.string().uuid() }),
  handler: async ({ user }, i) => {
    const rows = await many(
      `SELECT * FROM physio_milestones
       WHERE patient_id=$1 AND (provider_id=$2 OR patient_id=$2) AND archived_at IS NULL
       ORDER BY sort_order, target_date NULLS LAST`,
      [i.patient_id, user.id],
    );
    return rows.map(decRow);
  },
});

cap({
  name: 'archive_physio_milestone', method: 'POST', path: '/physio/milestones/:id/archive',
  tag: 'Physio', auth: true, summary: 'Archive (soft-delete) a milestone',
  input: z.object({ id: z.string().uuid() }),
  handler: async ({ user }, i) => {
    const existing = await one(`SELECT provider_id FROM physio_milestones WHERE id=$1`, [i.id]);
    if (!existing) throw notFound();
    if (existing.provider_id !== user.id) throw forbidden();
    return one(`UPDATE physio_milestones SET archived_at=now() WHERE id=$1 RETURNING id`, [i.id]);
  },
});

cap({
  name: 'record_outcome_measure', method: 'POST', path: '/physio/outcome-measures',
  tag: 'Physio', auth: true, summary: 'Record a standardised outcome measure score',
  input: z.object({
    patient_id: z.string().uuid(),
    measure_type: z.string().min(1).max(100),
    score: z.number(),
    max_score: z.number().optional(),
    notes: z.string().max(1000).optional(),
    measured_at: z.string().optional(),
  }),
  handler: async ({ user }, i) => {
    return one(
      `INSERT INTO physio_outcome_measures (patient_id, provider_id, measure_type, score, max_score, notes_enc, measured_at)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz, now())) RETURNING *`,
      [i.patient_id, user.id, i.measure_type, i.score, i.max_score ?? null,
        i.notes ? encrypt(i.notes, 'physio_outcome_measures.notes') : null,
        i.measured_at ?? null],
    );
  },
});

cap({
  name: 'list_outcome_measures', method: 'GET', path: '/physio/patients/:patient_id/outcome-measures',
  tag: 'Physio', auth: true, summary: 'List outcome measure history for a patient',
  input: z.object({
    patient_id: z.string().uuid(),
    measure_type: z.string().optional(),
  }),
  handler: async ({ user }, i) => {
    return many(
      `SELECT id, patient_id, provider_id, measure_type, score, max_score, measured_at, created_at
       FROM physio_outcome_measures
       WHERE patient_id=$1 AND (provider_id=$2 OR patient_id=$2)
         AND ($3::text IS NULL OR measure_type=$3)
       ORDER BY measured_at`,
      [i.patient_id, user.id, i.measure_type ?? null],
    );
  },
});
