import { z } from 'zod';
import { cap } from '../registry.js';
import { one, many } from '../db.js';
import { encrypt, decrypt } from '../crypto.js';
import { forbidden, notFound } from '../errors.js';

const CTX = 'physio_intake_forms';
const enc = (v, k) => (v != null ? encrypt(v, `${CTX}.${k}`) : null);
const dec = (v, k) => (v ? decrypt(v, `${CTX}.${k}`) : null);

function decRow(r) {
  if (!r) return r;
  return {
    ...r,
    chief_complaint: dec(r.chief_complaint_enc, 'chief_complaint'),
    aggravating_factors: dec(r.aggravating_factors_enc, 'aggravating_factors'),
    relieving_factors: dec(r.relieving_factors_enc, 'relieving_factors'),
    previous_treatment: dec(r.previous_treatment_enc, 'previous_treatment'),
    medications: dec(r.medications_enc, 'medications'),
    functional_goals: dec(r.functional_goals_enc, 'functional_goals'),
    chief_complaint_enc: undefined,
    aggravating_factors_enc: undefined,
    relieving_factors_enc: undefined,
    previous_treatment_enc: undefined,
    medications_enc: undefined,
    functional_goals_enc: undefined,
  };
}

cap({
  name: 'submit_physio_intake', method: 'POST', path: '/physio/intake',
  tag: 'Physio', auth: true, summary: 'Submit or update a patient intake form',
  input: z.object({
    appointment_id: z.string().uuid().optional(),
    patient_id: z.string().uuid(),
    chief_complaint: z.string().min(1).max(2000),
    pain_scale: z.number().int().min(0).max(10).optional(),
    pain_locations: z.array(z.string()).default([]),
    onset_date: z.string().optional(),
    mechanism: z.string().max(500).optional(),
    aggravating_factors: z.string().max(1000).optional(),
    relieving_factors: z.string().max(1000).optional(),
    previous_treatment: z.string().max(2000).optional(),
    medications: z.string().max(2000).optional(),
    red_flags: z.array(z.string()).default([]),
    functional_goals: z.string().max(1000).optional(),
    sport: z.string().max(100).optional(),
    training_load_hrs_week: z.number().min(0).max(168).optional(),
    consent_given: z.boolean().default(false),
  }),
  handler: async ({ user }, i) => {
    const row = await one(
      `INSERT INTO physio_intake_forms (
        appointment_id, patient_id, provider_id,
        chief_complaint_enc, pain_scale, pain_locations,
        onset_date, mechanism, aggravating_factors_enc, relieving_factors_enc,
        previous_treatment_enc, medications_enc, red_flags,
        functional_goals_enc, sport, training_load_hrs_week,
        consent_given, consent_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      RETURNING *`,
      [
        i.appointment_id ?? null, i.patient_id, user.id,
        enc(i.chief_complaint, 'chief_complaint'),
        i.pain_scale ?? null,
        JSON.stringify(i.pain_locations),
        i.onset_date ?? null,
        i.mechanism ?? null,
        enc(i.aggravating_factors, 'aggravating_factors'),
        enc(i.relieving_factors, 'relieving_factors'),
        enc(i.previous_treatment, 'previous_treatment'),
        enc(i.medications, 'medications'),
        JSON.stringify(i.red_flags),
        enc(i.functional_goals, 'functional_goals'),
        i.sport ?? null,
        i.training_load_hrs_week ?? null,
        i.consent_given,
        i.consent_given ? new Date().toISOString() : null,
      ],
    );
    return decRow(row);
  },
});

cap({
  name: 'get_physio_intake', method: 'GET', path: '/physio/intake/:id',
  tag: 'Physio', auth: true, summary: 'Get a physio intake form by ID',
  input: z.object({ id: z.string().uuid() }),
  handler: async ({ user }, i) => {
    const row = await one(`SELECT * FROM physio_intake_forms WHERE id=$1 AND archived_at IS NULL`, [i.id]);
    if (!row) throw notFound('Intake form not found');
    if (row.provider_id !== user.id && row.patient_id !== user.id) throw forbidden();
    return decRow(row);
  },
});

cap({
  name: 'list_physio_intakes', method: 'GET', path: '/physio/patients/:patient_id/intakes',
  tag: 'Physio', auth: true, summary: 'List intake forms for a patient',
  input: z.object({ patient_id: z.string().uuid() }),
  handler: async ({ user }, i) => {
    const rows = await many(
      `SELECT * FROM physio_intake_forms
       WHERE patient_id=$1 AND (provider_id=$2 OR patient_id=$2) AND archived_at IS NULL
       ORDER BY created_at DESC`,
      [i.patient_id, user.id],
    );
    return rows.map(decRow);
  },
});

cap({
  name: 'archive_physio_intake', method: 'POST', path: '/physio/intake/:id/archive',
  tag: 'Physio', auth: true, summary: 'Archive an intake form (soft-delete)',
  input: z.object({ id: z.string().uuid() }),
  handler: async ({ user }, i) => {
    const row = await one(`SELECT provider_id FROM physio_intake_forms WHERE id=$1`, [i.id]);
    if (!row) throw notFound();
    if (row.provider_id !== user.id) throw forbidden();
    return one(`UPDATE physio_intake_forms SET archived_at=now() WHERE id=$1 RETURNING id`, [i.id]);
  },
});
